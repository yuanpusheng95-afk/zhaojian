import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { streamSSE } from "hono/streaming";
import { cors } from "hono/cors";
import { z } from "zod";

import { ERROR_STATUS } from "../domain/errors.js";
import { AllowAllAccessPolicy, type AccessPolicy, type AccessAction } from "./access-policy.js";
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
  logger?: Console;
}

const MessageSchema = z.object({ message: z.string().min(1) });

/** 用户标识会进入 S3 key 路径，必须限制字符集和长度。 */
const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/**
 * V1 没有登录体系：请求头携带用户标识，缺省回落 dev。
 * 这是身份提示而非鉴权——真正的访问控制要等认证落地后再加。
 */
function resolveUserId(headerValue: string | undefined): string {
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

/** 统一访问检查入口：拒绝抛 404，隐藏资源存在性。 */
function assertProjectAccess(policy: AccessPolicy, userId: string, resource: { ownerId: string }, action: AccessAction) {
  policy.assertAccess({ userId, resource, action });
}

function errorResponse(error: unknown) {
  const code = (error as any)?.code ?? (error as any)?.cause?.code;
  if (error instanceof HttpError || code) {
    return {
      status: error instanceof HttpError ? error.status : ERROR_STATUS[code] ?? 500,
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

export function createApp({ repository, queue, turnViews, assetStorage, eventConsumer = null, accessPolicy = new AllowAllAccessPolicy(), logger = console }: AppDeps) {
  const app = new Hono();

  app.use("*", cors());

  app.onError((error, c) => {
    const mapped = errorResponse(error);
    if (mapped.status >= 500) logger.error("Unhandled error:", error);
    return c.json(mapped.body, mapped.status as any);
  });

  app.get("/health", (c) => c.json({ status: "ok" }));

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
    const userId = resolveUserId(c.req.header("x-user-id"));
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
    const ownerId = resolveUserId(c.req.header("x-user-id"));
    const project = await repository.createProject({
      ...body,
      initialState: body.initialState ?? {},
      ownerId,
    });
    return c.json(project, 201);
  });

  app.get("/projects/:projectId", async (c) => {
    const project = await repository.getProject(c.req.param("projectId"));
    assertProjectAccess(accessPolicy, resolveUserId(c.req.header("x-user-id")), project, "read");
    return c.json(project);
  });

  app.get("/generations/:generationId", async (c) => {
    const generation = await repository.getGeneration(c.req.param("generationId"));
    const project = await repository.getProject(generation.projectId);
    assertProjectAccess(accessPolicy, resolveUserId(c.req.header("x-user-id")), project, "read");
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
    assertProjectAccess(accessPolicy, resolveUserId(c.req.header("x-user-id")), project, "write");
    const result = await queue.requestTurn({ projectId, userMessage: message, idempotencyKey });
    return c.json(result, (result.replayed ? 200 : 202) as any);
  });

  app.get("/projects/:projectId/turns/:turnId", async (c) => {
    const project = await repository.getProject(c.req.param("projectId"));
    assertProjectAccess(accessPolicy, resolveUserId(c.req.header("x-user-id")), project, "read");
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
    assertProjectAccess(accessPolicy, resolveUserId(c.req.header("x-user-id")), project, "write");
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
    assertProjectAccess(accessPolicy, resolveUserId(c.req.header("x-user-id")), project, "read");

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
