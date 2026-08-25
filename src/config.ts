import { z } from "zod";

const DEFAULT_DATABASE_URL = "postgres://photo_agent:photo_agent@127.0.0.1:54329/photo_agent";

// ---------------------------------------------------------------------------
// 可复用 schema 片段
// ---------------------------------------------------------------------------

/** 必填环境变量：错误信息必须带变量名，运维 grep 得到。 */
function requiredString(name: string) {
  return z.string({ error: (issue) => issue.input === undefined ? `Missing required environment variable: ${name}` : `${name} must be a string` })
    .min(1, `${name} must not be empty`);
}

function positiveInt(name: string, fallback?: number) {
  const schema = z.coerce.number<number>().int(`${name} must be an integer`).positive(`${name} must be a positive integer`);
  return fallback === undefined
    ? schema
    : z.preprocess((v) => (v === undefined || v === "" ? fallback : v), schema);
}

const s3Fields = {
  S3_ENDPOINT: z.string().default("http://127.0.0.1:9000"),
  S3_PUBLIC_ENDPOINT: z.string().optional(),
  S3_BUCKET: z.string().default("photo-agent"),
  S3_ACCESS_KEY: requiredString("S3_ACCESS_KEY"),
  S3_SECRET_KEY: requiredString("S3_SECRET_KEY"),
  S3_REGION: z.string().default("us-east-1"),
} as const;

function s3Output(parsed: { S3_ENDPOINT: string; S3_PUBLIC_ENDPOINT?: string; S3_BUCKET: string; S3_ACCESS_KEY: string; S3_SECRET_KEY: string; S3_REGION: string }) {
  return {
    endpoint: parsed.S3_ENDPOINT,
    publicEndpoint: parsed.S3_PUBLIC_ENDPOINT ?? parsed.S3_ENDPOINT,
    bucket: parsed.S3_BUCKET,
    accessKey: parsed.S3_ACCESS_KEY,
    secretKey: parsed.S3_SECRET_KEY,
    region: parsed.S3_REGION,
  };
}

const imageSchema = z.object({
  IMAGE_BASE_URL: requiredString("IMAGE_BASE_URL"),
  IMAGE_API_KEY: requiredString("IMAGE_API_KEY"),
  IMAGE_MODEL: z.string().default("gpt-image-2"),
  IMAGE_SIZE: z.string().default("1024x1024"),
  IMAGE_EDIT_ROUTE: z.enum(["chat", "edits"]).default("chat"),
});

// ---------------------------------------------------------------------------
// 三个 loader：同一组片段，不同子集，不再重复解析逻辑
// ---------------------------------------------------------------------------

export function loadWorkerConfig(env: Record<string, string | undefined> = process.env) {
  const schema = z.object({
    DATABASE_URL: z.string().default(DEFAULT_DATABASE_URL),
    LLM_BASE_URL: z.string().default("https://api.deepseek.com"),
    LLM_API_KEY: requiredString("LLM_API_KEY"),
    LLM_MODEL: z.string().default("deepseek-v4-flash-vision-exp"),
    IMAGE_BASE_URL: imageSchema.shape.IMAGE_BASE_URL,
    IMAGE_API_KEY: imageSchema.shape.IMAGE_API_KEY,
    IMAGE_MODEL: imageSchema.shape.IMAGE_MODEL,
    IMAGE_SIZE: imageSchema.shape.IMAGE_SIZE,
    IMAGE_EDIT_ROUTE: imageSchema.shape.IMAGE_EDIT_ROUTE,
    ...s3Fields,
    MAX_IMAGES_PER_TURN: positiveInt("MAX_IMAGES_PER_TURN", 3),
    MAX_IMAGE_ATTEMPTS_PER_TURN: positiveInt("MAX_IMAGE_ATTEMPTS_PER_TURN").optional(),
    IMAGE_TIMEOUT_MS: positiveInt("IMAGE_TIMEOUT_MS", 180_000),
    TURN_TIMEOUT_MS: positiveInt("TURN_TIMEOUT_MS", 600_000),
    TURN_LEASE_MS: positiveInt("TURN_LEASE_MS", 30_000),
    TURN_HEARTBEAT_MS: positiveInt("TURN_HEARTBEAT_MS", 10_000),
    REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
    WORKER_CONCURRENCY: positiveInt("WORKER_CONCURRENCY", 4),
    SHUTDOWN_GRACE_MS: positiveInt("SHUTDOWN_GRACE_MS", 600_000),
    WORKER_POLL_INTERVAL_MS: positiveInt("WORKER_POLL_INTERVAL_MS", 500),
    TELEMETRY: z.string().default("stdout"),
  });

  const parsed = schema.parse(env);
  const maxImagesPerTurn = parsed.MAX_IMAGES_PER_TURN;
  return {
    databaseUrl: parsed.DATABASE_URL,
    llm: {
      baseUrl: parsed.LLM_BASE_URL,
      apiKey: parsed.LLM_API_KEY,
      modelId: parsed.LLM_MODEL,
    },
    image: {
      baseUrl: parsed.IMAGE_BASE_URL,
      apiKey: parsed.IMAGE_API_KEY,
      modelId: parsed.IMAGE_MODEL,
      size: parsed.IMAGE_SIZE,
      editRoute: parsed.IMAGE_EDIT_ROUTE,
    },
    s3: s3Output(parsed),
    guards: {
      maxImagesPerTurn,
      maxImageAttemptsPerTurn: parsed.MAX_IMAGE_ATTEMPTS_PER_TURN ?? 2 * maxImagesPerTurn,
      imageTimeoutMs: parsed.IMAGE_TIMEOUT_MS,
      turnTimeoutMs: parsed.TURN_TIMEOUT_MS,
    },
    turnLeaseMs: parsed.TURN_LEASE_MS,
    heartbeatMs: parsed.TURN_HEARTBEAT_MS,
    redisUrl: parsed.REDIS_URL,
    workerConcurrency: parsed.WORKER_CONCURRENCY,
    shutdownGraceMs: parsed.SHUTDOWN_GRACE_MS,
    pollIntervalMs: parsed.WORKER_POLL_INTERVAL_MS,
    telemetry: parsed.TELEMETRY,
  };
}

export function loadImageConfig(env: Record<string, string | undefined> = process.env) {
  const schema = z.object({
    IMAGE_BASE_URL: imageSchema.shape.IMAGE_BASE_URL,
    IMAGE_API_KEY: imageSchema.shape.IMAGE_API_KEY,
    IMAGE_MODEL: imageSchema.shape.IMAGE_MODEL,
    IMAGE_SIZE: imageSchema.shape.IMAGE_SIZE,
    IMAGE_EDIT_ROUTE: imageSchema.shape.IMAGE_EDIT_ROUTE,
    ...s3Fields,
    IMAGE_TIMEOUT_MS: positiveInt("IMAGE_TIMEOUT_MS", 180_000),
  });
  const parsed = schema.parse(env);
  return {
    image: {
      baseUrl: parsed.IMAGE_BASE_URL,
      apiKey: parsed.IMAGE_API_KEY,
      modelId: parsed.IMAGE_MODEL,
      size: parsed.IMAGE_SIZE,
      editRoute: parsed.IMAGE_EDIT_ROUTE,
    },
    s3: s3Output(parsed),
    guards: { imageTimeoutMs: parsed.IMAGE_TIMEOUT_MS },
  };
}

export function loadApiConfig(env: Record<string, string | undefined> = process.env) {
  const schema = z.object({
    DATABASE_URL: z.string().default(DEFAULT_DATABASE_URL),
    PORT: positiveInt("PORT", 3000),
    ...s3Fields,
    SIGNED_URL_TTL_SECONDS: positiveInt("SIGNED_URL_TTL_SECONDS", 900),
    REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
    JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
    CORS_ORIGIN: z.string().default("*"),
  });
  const parsed = schema.parse(env);
  return {
    databaseUrl: parsed.DATABASE_URL,
    port: parsed.PORT,
    s3: s3Output(parsed),
    signedUrlTtlSeconds: parsed.SIGNED_URL_TTL_SECONDS,
    redisUrl: parsed.REDIS_URL,
    jwtSecret: parsed.JWT_SECRET,
    corsOrigin: parsed.CORS_ORIGIN,
  };
}
