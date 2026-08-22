/**
 * 启动配置。
 *
 * **校验排在最前**——一个变量都不缺再去连数据库或建客户端，否则会在跑完
 * 其他初始化之后才失败，浪费启动时间并可能留下半初始化状态（设计文档 §12.3）。
 */

function required(env, name) {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function integer(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${raw}`);
  }
  return value;
}

const DEFAULT_DATABASE_URL =
  'postgres://photo_agent:photo_agent@127.0.0.1:54329/photo_agent';

function s3Config(env) {
  return {
    endpoint: env.S3_ENDPOINT ?? 'http://127.0.0.1:9000',
    bucket: env.S3_BUCKET ?? 'photo-agent',
    accessKey: required(env, 'S3_ACCESS_KEY'),
    secretKey: required(env, 'S3_SECRET_KEY'),
    region: env.S3_REGION ?? 'us-east-1',
  };
}

export function loadWorkerConfig(env = process.env) {
  return {
    databaseUrl: env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    llm: {
      baseUrl: env.LLM_BASE_URL ?? 'https://api.deepseek.com',
      apiKey: required(env, 'LLM_API_KEY'),
      modelId: env.LLM_MODEL ?? 'deepseek-v4-flash-vision-exp',
    },
    image: {
      baseUrl: required(env, 'IMAGE_BASE_URL'),
      apiKey: required(env, 'IMAGE_API_KEY'),
      modelId: env.IMAGE_MODEL ?? 'gpt-image-2',
    },
    s3: s3Config(env),
    guards: {
      maxImagesPerTurn: integer(env, 'MAX_IMAGES_PER_TURN', 3),
      imageTimeoutMs: integer(env, 'IMAGE_TIMEOUT_MS', 180_000),
      turnTimeoutMs: integer(env, 'TURN_TIMEOUT_MS', 600_000),
    },
    telemetry: env.TELEMETRY ?? 'stdout',
  };
}

/** API 不加载 pi Agent（设计文档 §3.1），因此不需要任何模型凭证。 */
export function loadApiConfig(env = process.env) {
  return {
    databaseUrl: env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    port: integer(env, 'PORT', 3000),
    s3: s3Config(env),
  };
}
