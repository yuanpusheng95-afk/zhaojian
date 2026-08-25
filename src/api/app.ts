import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { streamSSE } from "hono/streaming";
import { cors } from "hono/cors";
import type { Pool } from "pg";

import { z } from "zod";

import { ERROR_STATUS } from "../domain/errors.js";
import { AllowAllAccessPolicy, type AccessPolicy, type AccessAction } from "./access-policy.js";
import { OwnerOnlyAccessPolicy } from "./owner-only-policy.js";
import { AuthError, type JwtSessionStore } from "../infrastructure/auth/jwt-session.js";
import { createAuthRoutes } from "../infrastructure/auth/routes.js";
import { HttpError } from "./http-error.js";

import { createTurnEventStream, parsePollMs } from "./sse.js";
import type { TurnViews } from "./turn-views.js";
import type { PhotoProjectRepository } from "../domain/photo-project.js";
import type { AgentTurnQueue } from "../infrastructure/postgres/agent-turn-queue.js";
import type { TurnEventConsumer } from "../infrastructure/redis/turn-events.js";
import type { AssetStorageLike } from "../infrastructure/storage/asset-storage.js";

export interface AppDeps {
  repository: Pick<PhotoProjectRepository, "createProject" | "getProject" | "getGeneration" | "recordAsset" | "selectCandidate">;
  queue: Pick<AgentTurnQueue, "requestTurn">;
  turnViews: TurnViews;
  assetStorage: Pick<AssetStorageLike, "put" | "bucket">;
  eventConsumer?: Pick<TurnEventConsumer, "readTurnEvent"> | null;
  accessPolicy?: AccessPolicy;
  /** 提供后启用 JWT 认证：未登录请求 401，身份来自 token 而非请求头。 */
  sessionStore?: JwtSessionStore;
  /** users 表访问；认证模式下必填。 */
  authPool?: Pool;
  logger?: Console;
}

const MessageSchema = z.object({ message: z.string().min(1) });

/** 用户标识会进入 S3 key 路径，必须限制字符集和长度。 */
const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/**
 * V1 没有登录体系：请求头携带用户标识，缺省回落 dev。
 * 这是身份提示而非鉴权——真正的访问控制要等认证落地后再加。
 */
function legacyUserId(headerValue: string | undefined): string {
  const userId = (headerValue ?? "").trim();
  if (!userId) return "dev";
  if (!USER_ID_PATTERN.test(userId)) {
    throw new HttpError(
      400,
      "INVALID_USER_ID",
      "x-user-id must start with a letter or digit, contain only [A-Za-z0-9._:-], and be at most 64 characters",
    );
  }
  return userId;
}

/**
 * 认证模式：身份必须来自 JWT cookie，缺失即 401。
 * 匿名模式（无 sessionStore）：回落 x-user-id / dev，仅用于测试与本地调试。
 */
function currentUserId(c: { get(key: "userId"): string | undefined; req: { header(name: string): string | undefined } }, sessionStore?: JwtSessionStore): string {
  if (sessionStore) {
    const userId = c.get("userId");
    if (!userId) throw new HttpError(401, "UNAUTHENTICATED", "Sign in required");
    return userId;
  }
  return legacyUserId(c.req.header("x-user-id"));
}

const AUTH_COOKIE_NAME = "auth_token";

function readAuthToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === AUTH_COOKIE_NAME) return rest.join("=");
  }
  return null;
}

/** 统一访问检查入口：拒绝抛 404，隐藏资源存在性。 */
function assertProjectAccess(policy: AccessPolicy, userId: string, resource: { ownerId: string }, action: AccessAction) {
  policy.assertAccess({ userId, resource, action });
}

function errorResponse(error: unknown) {
  const coded = error as { code?: string; cause?: { code?: string } };
  const code = coded?.code ?? coded?.cause?.code;
  if (error instanceof HttpError || code) {
    return {
      status: error instanceof HttpError ? error.status : (code && ERROR_STATUS[code]) || 500,
      body: {
        error: {
          code: error instanceof HttpError ? error.code : code,
          message: (error as Error).message,
        },
      },
    };
  }
  return { status: 500, body: { error: { code: "INTERNAL_ERROR", message: "Internal server error" } } };
}

export function createApp({ repository, queue, turnViews, assetStorage, eventConsumer = null, accessPolicy, sessionStore, authPool, logger = console }: AppDeps) {
  const app = new Hono();
  // 认证开启时强制归属校验；未开启（测试/本地）保持放行
  const policy = accessPolicy ?? (sessionStore ? new OwnerOnlyAccessPolicy() : new AllowAllAccessPolicy());

  app.use("*", cors());

  // 从 cookie 解析登录用户；认证模式下挂到 c.var.userId
  app.use("*", async (c, next) => {
    if (!sessionStore) return next();
    const token = readAuthToken(c.req.header("cookie"));
    if (!token) return next();
    try {
      const { userId } = await sessionStore.verify(token);
      (c as unknown as { set(key: "userId", value: string): void }).set("userId", userId);
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      // 无效 token 视为未登录，继续走匿名分支（受保护路由会 401）
    }
    return next();
  });

  app.onError((error, c) => {
    const mapped = errorResponse(error);
    if (mapped.status >= 500) logger.error("Unhandled error:", error);
    return c.json(mapped.body, mapped.status as never);
  });

  app.get("/health", (c) => c.json({ status: "ok" }));

  if (sessionStore) {
    app.route("/", createAuthRoutes({ pool: authPool!, sessionStore }));
  }

  app.use("/", serveStatic({ root: "./public", index: "index.html" }));

  app.post("/uploads", async (c) => {
    const contentType = c.req.header("content-type") ?? "";
    const mediaType = contentType.toLowerCase().split(";")[0].trim();
    if (!mediaType.startsWith("image/")) {
      throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be image/*");
    }
    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength > 20 * 1024 * 1024) {
      return c.json({ error: { code: "REQUEST_TOO_LARGE", message: "Upload exceeds 20971520 bytes" } }, 413);
    }
    const buffer = Buffer.from(bytes);
    const userId = currentUserId(c, sessionStore);
    const assetId = `upload_${crypto.randomUUID()}`;
    const extension = mediaType.split("/")[1] ?? "png";
    const key = `users/${userId}/projects/uploads/${assetId}.${extension}`;
    await assetStorage.put(key, buffer, mediaType);
    const uri = `s3://${assetStorage.bucket}/${key}`;
    const metadata = { contentType };
    const asset = await repository.recordAsset({ assetId, uri, metadata });
    return c.json({ assetId: asset.id, uri: asset.uri, metadata: asset.metadata }, 201);
  });

  app.post("/projects", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body?.name !== "string" || !body.name.trim()) throw new HttpError(400, "INVALID_PROJECT", "name is required");
    const ownerId = currentUserId(c, sessionStore);
    const project = await repository.createProject({
      ...body,
      initialState: body.initialState ?? {},
      ownerId,
    });
    return c.json(project, 201);
  });

  app.get("/projects/:projectId", async (c) => {
    const project = await repository.getProject(c.req.param("projectId"));
    assertProjectAccess(policy, currentUserId(c, sessionStore), project, "read");
    return c.json(project);
  });

  app.get("/generations/:generationId", async (c) => {
    const generation = await repository.getGeneration(c.req.param("generationId"));
    const project = await repository.getProject(generation.projectId);
    assertProjectAccess(policy, currentUserId(c, sessionStore), project, "read");
    return c.json(generation);
  });

  app.post("/projects/:projectId/messages", async (c) => {
    const projectId = c.req.param("projectId");
    const body = await c.req.json();
    const parsedMessage = MessageSchema.safeParse(body);
    if (!parsedMessage.success || !parsedMessage.data.message.trim()) {
      throw new HttpError(400, "INVALID_MESSAGE", "message must be a non-empty string");
    }
    const message = parsedMessage.data.message;
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey?.trim()) throw new HttpError(400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required");
    const project = await repository.getProject(projectId);
    assertProjectAccess(policy, currentUserId(c, sessionStore), project, "write");
    const result = await queue.requestTurn({ projectId, userMessage: message, idempotencyKey });
    return c.json(result, (result.replayed ? 200 : 202) as never);
  });

  app.get("/projects/:projectId/turns/:turnId", async (c) => {
    const project = await repository.getProject(c.req.param("projectId"));
    assertProjectAccess(policy, currentUserId(c, sessionStore), project, "read");
    const view = await turnViews.loadTurnDetail({ projectId: c.req.param("projectId"), turnId: c.req.param("turnId") });
    return c.json(view);
  });

  app.post("/projects/:projectId/turns/:turnId/selections", async (c) => {
    const projectId = c.req.param("projectId");
    const turnId = c.req.param("turnId");
    const body = await c.req.json().catch(() => ({}));
    if (typeof body?.generationId !== "string" || !body.generationId.trim() ||
        typeof body?.candidateId !== "string" || !body.candidateId.trim()) {
      throw new HttpError(400, "INVALID_SELECTION", "generationId and candidateId are required");
    }
    await turnViews.assertTurnExists({ projectId, turnId });
    const project = await repository.getProject(projectId);
    assertProjectAccess(policy, currentUserId(c, sessionStore), project, "write");
    const revision = await repository.selectCandidate({
      projectId,
      generationId: body.generationId,
      candidateId: body.candidateId,
    });
    return c.json({ revisionId: revision.id });
  });

  app.get("/projects/:projectId/turns/:turnId/events", async (c) => {
    const projectId = c.req.param("projectId");
    const turnId = c.req.param("turnId");
    const pollMs = parsePollMs(c.req.query("pollMs"));
    const abortSignal = c.req.raw.signal;
    const project = await repository.getProject(projectId);
    assertProjectAccess(policy, currentUserId(c, sessionStore), project, "read");

    return streamSSE(c, async (stream) => {
      const events = createTurnEventStream({
        turnViews,
        eventConsumer,
        projectId,
        turnId,
        pollMs,
        signal: abortSignal,
        onFallback: (error) => {
          logger.warn("Turn event Redis consumer failed; falling back to database polling", { error });
        },
      });

      for await (const event of events) {
        if (event.type === "snapshot") {
          await stream.writeSSE({ event: "turn", data: JSON.stringify(event.view) });
        } else if (event.type === "done") {
          await stream.writeSSE({ event: "done", data: "{}" });
          return;
        } else {
          await stream.writeSSE({ event: "error", data: JSON.stringify(event.payload) });
          return;
        }
      }
    });
  });

  return app;
}
