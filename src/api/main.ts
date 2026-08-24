import pg from "pg";
import Redis from "ioredis";
import { serve } from "@hono/node-server";

import { loadApiConfig } from "../config.js";
import { PostgresPhotoProjectRepository } from "../infrastructure/postgres/photo-project-repository.js";
import { createAgentTurnQueue } from "../infrastructure/postgres/agent-turn-queue.js";
import { createS3AssetStorage } from "../infrastructure/storage/s3-asset-storage.js";
import { createTurnViews } from "./turn-views.js";
import { createApp } from "./app.js";
import { createTurnEventConsumer } from "../infrastructure/redis/turn-events.js";

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
const app = createApp({
  pool,
  repository,
  queue,
  turnViews,
  assetStorage,
  eventConsumer: createTurnEventConsumer(redis),
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  process.stdout.write(`Photo Agent API listening on :${info.port}\n`);
});
