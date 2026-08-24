import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { streamSSE } from "hono/streaming";
import { cors } from "hono/cors";
import { parsePollMs } from "./sse.js";
import { z } from "zod";
import type { Pool } from "pg";

export interface AppDeps {
  pool: Pool | any;
  repository: any;
  queue: any;
  turnViews: any;
  assetStorage: any;
  eventConsumer?: any;
  logger?: Console;
}

const MessageSchema = z.object({ message: z.string().min(1) });

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

const ERROR_STATUS: Record<string, number> = {
  PROJECT_NOT_FOUND: 404,
  GENERATION_NOT_FOUND: 404,
  TURN_NOT_FOUND: 404,
  REVISION_NOT_FOUND: 404,
  ASSET_NOT_FOUND: 404,
  UNSUPPORTED_MEDIA_TYPE: 415,
  "23505": 409,
  REVISION_CONFLICT: 409,
  CANDIDATE_SELECTION_ERROR: 409,
  PROJECT_EXISTS: 409,
  IDEMPOTENCY_CONFLICT: 409,
  PROJECT_BUSY: 409,
  INVALID_GENERATION_REQUEST: 400,
  INVALID_STATE_PATCH: 400,
  UNSAFE_STATE_PATH: 400,
  PATCH_CONFLICT: 400,
};

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

export function createApp({ pool, repository, queue, turnViews, assetStorage, eventConsumer, logger = console }: AppDeps) {
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
    const assetId = `upload_${crypto.randomUUID()}`;
    const extension = mediaType.split("/")[1] ?? "png";
    const key = `users/dev/projects/uploads/${assetId}.${extension}`;
    await assetStorage.put(key, buffer, mediaType);
    const uri = `s3://${assetStorage.bucket}/${key}`;
    const metadata = { contentType };
    const asset = await repository.recordAsset({ assetId, uri, metadata });
    return c.json({ assetId: asset.id, uri: asset.uri, metadata: asset.metadata }, 201);
  });

  app.post("/projects", async (c) => {
    const body = await c.req.json();
    if (typeof body?.name !== "string" || !body.name.trim()) throw new HttpError(400, "INVALID_PROJECT", "name is required");
    const project = await repository.createProject(body);
    return c.json(project, 201);
  });

  app.get("/projects/:projectId", async (c) => {
    const project = await repository.getProject(c.req.param("projectId"));
    return c.json(project);
  });

  app.get("/generations/:generationId", async (c) => {
    const generation = await repository.getGeneration(c.req.param("generationId"));
    return c.json(generation);
  });

  app.get("/assets/:assetId/url", async (c) => {
    const view = await turnViews.assetUrl(c.req.param("assetId"));
    return c.json(view);
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
    const result = await queue.requestTurn({ projectId, userMessage: message, idempotencyKey });
    return c.json(result, (result.replayed ? 200 : 202) as any);
  });

  app.get("/projects/:projectId/turns/:turnId", async (c) => {
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
    const revision = await repository.selectCandidate({
      projectId,
      generationId: body.generationId,
      candidateId: body.candidateId,
    });
    return c.json({ revisionId: revision.id });
  });

  app.get("/projects/:projectId/turns/:turnId/events", (c) => {
    const projectId = c.req.param("projectId");
    const turnId = c.req.param("turnId");
    const pollMs = parsePollMs(c.req.query("pollMs"));
    const abortSignal = c.req.raw.signal;

    let streamClosed = false;
    abortSignal.addEventListener("abort", () => { streamClosed = true; });

    return streamSSE(c, async (stream) => {
      let lastFingerprint: string | null | undefined;
      let useRedis = eventConsumer != null;
      if (eventConsumer) {
        let lastEventId = "0";
        while (!streamClosed && !abortSignal.aborted) {
          try {
            const next = await eventConsumer.readTurnEvent(turnId, lastEventId, 250);
            if (next) {
              lastEventId = next.id;
              const view = await turnViews.loadTurnDetail({ projectId, turnId });
              await stream.writeSSE({ event: "turn", data: JSON.stringify(view) });
              if (["completed", "failed", "aborted"].includes(view.status)) {
                await stream.writeSSE({ event: "done", data: "{}" });
                return;
              }
            }
          } catch {
            useRedis = false;
            break;
          }
        }
      }

      while (!useRedis && !streamClosed && !abortSignal.aborted) {
        try {
          const changed = await turnViews.turnChangedSince({ projectId, turnId, lastFingerprint });
          lastFingerprint = changed.fingerprint;
          if (!changed.changed) {
            await stream.sleep(pollMs);
            continue;
          }
          const view = await turnViews.loadTurnDetail({ projectId, turnId });
          await stream.writeSSE({ event: "turn", data: JSON.stringify(view) });
          if (["completed", "failed", "aborted"].includes(view.status)) {
            await stream.writeSSE({ event: "done", data: "{}" });
            break;
          }
        } catch (error: any) {
          const payload = ["TURN_NOT_FOUND", "REVISION_NOT_FOUND", "ASSET_NOT_FOUND", "INVALID_ASSET_URI"].includes(error?.code)
            ? { code: error.code, message: error.message }
            : { code: "INTERNAL_ERROR", message: "Turn event stream failed" };
          await stream.writeSSE({ event: "error", data: JSON.stringify(payload) });
          break;
        }
      }
    });
  });

  return app;
}
