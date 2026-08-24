function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function integer(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${raw}`);
  }
  return value;
}

type EditRoute = "chat" | "edits";

function editRoute(env: Record<string, string | undefined>): EditRoute {
  const value = env.IMAGE_EDIT_ROUTE ?? "chat";
  if (value !== "chat" && value !== "edits") {
    throw new Error(`IMAGE_EDIT_ROUTE must be "chat" or "edits", got: ${value}`);
  }
  return value;
}

const DEFAULT_DATABASE_URL = "postgres://photo_agent:photo_agent@127.0.0.1:54329/photo_agent";

interface S3Config {
  endpoint: string;
  publicEndpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
}

function s3Config(env: Record<string, string | undefined>): S3Config {
  const endpoint = env.S3_ENDPOINT ?? "http://127.0.0.1:9000";
  return {
    endpoint,
    publicEndpoint: env.S3_PUBLIC_ENDPOINT ?? endpoint,
    bucket: env.S3_BUCKET ?? "photo-agent",
    accessKey: required(env, "S3_ACCESS_KEY"),
    secretKey: required(env, "S3_SECRET_KEY"),
    region: env.S3_REGION ?? "us-east-1",
  };
}

export function loadWorkerConfig(env: Record<string, string | undefined> = process.env) {
  return {
    databaseUrl: env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    llm: {
      baseUrl: env.LLM_BASE_URL ?? "https://api.deepseek.com",
      apiKey: required(env, "LLM_API_KEY"),
      modelId: env.LLM_MODEL ?? "deepseek-v4-flash-vision-exp",
    },
    image: {
      baseUrl: required(env, "IMAGE_BASE_URL"),
      apiKey: required(env, "IMAGE_API_KEY"),
      modelId: env.IMAGE_MODEL ?? "gpt-image-2",
      size: env.IMAGE_SIZE ?? "1024x1024",
      editRoute: editRoute(env),
    },
    s3: s3Config(env),
    guards: (() => {
      const maxImagesPerTurn = integer(env, "MAX_IMAGES_PER_TURN", 3);
      return {
        maxImagesPerTurn,
        maxImageAttemptsPerTurn: integer(env, "MAX_IMAGE_ATTEMPTS_PER_TURN", 2 * maxImagesPerTurn),
        imageTimeoutMs: integer(env, "IMAGE_TIMEOUT_MS", 180_000),
        turnTimeoutMs: integer(env, "TURN_TIMEOUT_MS", 600_000),
      };
    })(),
    turnLeaseMs: integer(env, "TURN_LEASE_MS", 30_000),
    heartbeatMs: integer(env, "TURN_HEARTBEAT_MS", 10_000),
    redisUrl: env.REDIS_URL ?? "redis://127.0.0.1:6379",
    workerConcurrency: integer(env, "WORKER_CONCURRENCY", 4),
    shutdownGraceMs: integer(env, "SHUTDOWN_GRACE_MS", 600_000),
    pollIntervalMs: integer(env, "WORKER_POLL_INTERVAL_MS", 500),
    telemetry: env.TELEMETRY ?? "stdout",
  };
}

export function loadImageConfig(env: Record<string, string | undefined> = process.env) {
  return {
    image: {
      baseUrl: required(env, "IMAGE_BASE_URL"),
      apiKey: required(env, "IMAGE_API_KEY"),
      modelId: env.IMAGE_MODEL ?? "gpt-image-2",
      size: env.IMAGE_SIZE ?? "1024x1024",
      editRoute: editRoute(env),
    },
    s3: s3Config(env),
    guards: { imageTimeoutMs: integer(env, "IMAGE_TIMEOUT_MS", 180_000) },
  };
}

export function loadApiConfig(env: Record<string, string | undefined> = process.env) {
  return {
    databaseUrl: env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    port: integer(env, "PORT", 3000),
    s3: s3Config(env),
    signedUrlTtlSeconds: integer(env, "SIGNED_URL_TTL_SECONDS", 900),
    redisUrl: env.REDIS_URL ?? "redis://127.0.0.1:6379",
    corsOrigin: env.CORS_ORIGIN ?? "*",
  };
}
