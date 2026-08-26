import pg from "pg";
import Redis from "ioredis";
import { serve } from "@hono/node-server";

import { loadApiConfig } from "@/config";
import { PostgresPhotoProjectRepository } from "@/infrastructure/postgres/photo-project-repository";
import { createAgentTurnQueue } from "@/infrastructure/postgres/agent-turn-queue";
import { createS3AssetStorage } from "@/infrastructure/storage/s3-asset-storage";
import { createTurnViews } from "@/api/turn-views";
import { createApp } from "@/api/app";
import { createTurnEventConsumer } from "@/infrastructure/redis/turn-events";
import { createJwtSessionStore } from "@/infrastructure/auth/jwt-session";

const config = loadApiConfig(process.env);
const pool = new pg.Pool({ connectionString: config.databaseUrl });

const repository = new PostgresPhotoProjectRepository({ pool });
const queue = createAgentTurnQueue({ pool });
const assetStorage = createS3AssetStorage(config.s3);
const turnViews = createTurnViews({
  pool,
  repository,
  assetStorage,
  signedUrlTtlSeconds: config.signedUrlTtlSeconds,
});
const redis = new Redis(config.redisUrl);
const sessionStore = createJwtSessionStore({ jwtSecret: config.jwtSecret, redis });
const app = createApp({
  repository,
  queue,
  turnViews,
  assetStorage,
  eventConsumer: createTurnEventConsumer(redis),
  sessionStore,
  authPool: pool,
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  process.stdout.write(`Photo Agent API listening on :${info.port}\n`);
});
