# 切片 2a：供应商适配层 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打通「基准图 + 编辑指令 → 真实生成的图落进对象存储」这条链路，并用真实调用验证两个供应商假设，为后续 Agent 接线扫清未知。

**Architecture:** 两条互不相关的供应商管道各自实现：文本走 DeepSeek（pi-ai 内置 `openai-completions`，只需手写 Model 字面量），图像走中转站的 OpenAI Images API（自定义 `ImagesFunction`）。对象存储抽象成 `AssetStorage` port，S3 兼容实现同时覆盖 MinIO / OSS / COS。本切片**不碰** schema、domain、Agent、API。

**Tech Stack:** Node.js 22+ 原生 ESM（`.mjs`，无构建）、`@earendil-works/pi-ai`、`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`、MinIO（docker compose）、`node:test`

**设计文档：** `docs/superpowers/specs/2026-08-20-pi-agent-migration-design.md` §4、§6、§11.3、§11.4

**前置：** 切片 1（PostgreSQL 会话后端）已完成，conformance 30/30。

## Global Constraints

- Node.js `>=22`，**不引入构建步骤**，源码为 `.mjs`
- **不引入 vitest**，测试用 `node:test`
- pi 版本锁定 `@earendil-works/pi-ai@0.84.2`（与已装的 `pi-agent-core` 同版本）
- 本切片**不修改** `src/domain/**`、`src/api/**`、`src/worker/**`、`migrations/**`、`src/infrastructure/postgres/**`
- **集成测试必须串行**：`npm run test:integration` 已带 `--test-concurrency=1`，新增测试文件不得改回并行
- 真实供应商调用**只出现在手动脚本里，不进 CI**——CI 不花钱、不依赖网络

## 本切片在整体中的位置

切片 2 已拆为四份计划，本文件是第一份：

| | 内容 | 依赖 |
|---|---|---|
| **2a（本计划）** | 供应商探针、对象存储、ImagesProvider、telemetry | 切片 1 |
| 2b | 迁移 006–009、domain 项目锁上移、repository 方法改造 | 切片 1 |
| 2c | Tools、system prompt、AgentHarness、Worker 并发重写 | 2a + 2b |
| 2d | API 路由与 mapError、端到端冒烟 | 2c |

## 为什么第一个任务是「探针」

切片 1 的教训：**从接口签名反推语义，返工了一轮。** 本切片有两个只能靠实物确定的未知——中转站 `/v1/images/edits` 的真实响应格式，与 DeepSeek 对 function calling + 图片输入的透传行为。

因此 Task 1 先用真实调用把它们打出来存成样本，Task 3 的解析代码**照着样本写**，不猜。

## File Structure

```text
scripts/probe-providers.mjs                        真实调用探针，手动执行（花极少量钱）
src/infrastructure/storage/asset-storage.mjs       Port 契约与参数校验
src/infrastructure/storage/s3-asset-storage.mjs    S3 兼容实现（MinIO / OSS / COS）
src/infrastructure/models/relay-images-provider.mjs  relayGenerateImages：ImagesFunction
src/infrastructure/models/llm-provider.mjs         DeepSeek 文本模型接线
src/infrastructure/telemetry/stdout-telemetry.mjs  TelemetryContext adapter
src/config.mjs                                     环境变量读取与启动即校验
test/relay-images-provider.test.mjs                fake fetch 驱动的解析单测
test/stdout-telemetry.test.mjs                     span 输出格式单测
test/config.test.mjs                               必填项缺失即失败
test-integration/asset-storage.test.mjs            真实 MinIO 往返
scripts/smoke-image.mjs                            真实生图落 MinIO，手动执行
compose.yaml                                       新增 MinIO 服务
.env.example                                       运行配置模板
```

按职责拆：`asset-storage.mjs` 只定义契约与校验，`s3-asset-storage.mjs` 只有 S3 细节——将来换实现不碰契约。

---

### Task 1: 供应商探针

先拿真实响应，后写解析代码。本任务**不写任何产品代码**，产出是两份样本 JSON。

**Files:**
- Create: `scripts/probe-providers.mjs`
- Create: `.env.example`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: 无
- Produces: `.probe/chat.json`、`.probe/images.json` 两份真实响应样本（不入库）

- [ ] **Step 1: 写 .env.example**

```bash
# --- PostgreSQL（切片 1 已用）---
DATABASE_URL=postgres://photo_agent:photo_agent@127.0.0.1:54329/photo_agent

# --- 文本模型（Agent 大脑）---
LLM_BASE_URL=https://api.deepseek.com
LLM_API_KEY=
LLM_MODEL=deepseek-v4-flash-vision-exp

# --- 图像模型（中转站）---
IMAGE_BASE_URL=
IMAGE_API_KEY=
IMAGE_MODEL=gpt-image-2

# --- 对象存储（开发用 MinIO）---
S3_ENDPOINT=http://127.0.0.1:9000
S3_BUCKET=photo-agent
S3_ACCESS_KEY=photoagent
S3_SECRET_KEY=photoagent123
S3_REGION=us-east-1

# --- 护栏与超时 ---
MAX_IMAGES_PER_TURN=3
IMAGE_TIMEOUT_MS=180000
TELEMETRY=stdout
```

- [ ] **Step 2: 忽略探针产物**

在 `.gitignore` 追加：

```text
.probe/
.env
```

- [ ] **Step 3: 写探针脚本**

创建 `scripts/probe-providers.mjs`：

```js
// 真实供应商探针。手动执行，会产生极少量费用。
// 目的：把两个只能靠实物确定的行为打出来存样本，供后续解析代码照着写。
import { mkdir, writeFile } from 'node:fs/promises';

const OUT = new URL('../.probe/', import.meta.url);

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

/** 1x1 红色 PNG，避免探针依赖外部图片。 */
const RED_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function probeChat() {
  const body = {
    model: process.env.LLM_MODEL ?? 'deepseek-v4-flash-vision-exp',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '这张图是什么颜色？必须调用 report_color 工具回答。' },
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${RED_PIXEL_PNG_BASE64}` },
          },
        ],
      },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'report_color',
          description: 'Report the dominant color of the image',
          parameters: {
            type: 'object',
            properties: { color: { type: 'string' } },
            required: ['color'],
          },
        },
      },
    ],
  };

  const response = await fetch(
    `${required('LLM_BASE_URL')}/v1/chat/completions`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${required('LLM_API_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
  return { status: response.status, body: await response.json() };
}

async function probeImages() {
  const form = new FormData();
  form.set('model', process.env.IMAGE_MODEL ?? 'gpt-image-2');
  form.set('prompt', '把背景换成海边沙滩，保持主体不变');
  form.set(
    'image',
    new Blob([Buffer.from(RED_PIXEL_PNG_BASE64, 'base64')], { type: 'image/png' }),
    'base.png',
  );

  const response = await fetch(`${required('IMAGE_BASE_URL')}/v1/images/edits`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${required('IMAGE_API_KEY')}` },
    body: form,
  });
  return { status: response.status, body: await response.json() };
}

/** 样本可能很大（b64 图片），截断后再存，只保留结构。 */
function summarize(value, depth = 0) {
  if (typeof value === 'string') {
    return value.length > 120 ? `${value.slice(0, 120)}…<${value.length} chars>` : value;
  }
  if (Array.isArray(value)) return value.map((item) => summarize(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, summarize(item, depth + 1)]),
    );
  }
  return value;
}

await mkdir(OUT, { recursive: true });

const chat = await probeChat();
await writeFile(new URL('chat.json', OUT), JSON.stringify(summarize(chat), null, 2));
const toolCalls = chat.body?.choices?.[0]?.message?.tool_calls;
process.stdout.write(
  `chat: status=${chat.status} tool_calls=${toolCalls ? JSON.stringify(toolCalls) : 'NONE'}\n`,
);

const images = await probeImages();
await writeFile(new URL('images.json', OUT), JSON.stringify(summarize(images), null, 2));
const first = images.body?.data?.[0];
process.stdout.write(
  `images: status=${images.status} keys=${first ? Object.keys(first).join(',') : 'NONE'}\n`,
);
```

- [ ] **Step 4: 填 .env 并运行探针**

```bash
cp .env.example .env
# 编辑 .env，填入 LLM_API_KEY、IMAGE_BASE_URL、IMAGE_API_KEY
node --env-file=.env scripts/probe-providers.mjs
```

- [ ] **Step 5: 判读结果，记录结论**

对照两条判据：

| 输出 | 含义 | 若不满足 |
|---|---|---|
| `chat: ... tool_calls=[{...report_color...}]` 且参数里颜色为红 | function calling 与图片输入**同时可用** | 见下方「假设不成立时」 |
| `images: ... keys=b64_json` 或 `keys=url` | 拿到图像响应的真实字段 | 中转站格式非标准，Task 3 需按 `.probe/images.json` 调整 |

**把 `.probe/images.json` 里 `data[0]` 的实际字段名记下来，Task 3 的解析要照它写，不要照 OpenAI 文档猜。**

**假设不成立时不要继续硬写：**

- `tool_calls` 为空但 `content` 里描述了颜色 → 模型能看图但**不调工具**，agent 循环不成立。停下来，换一个支持 function calling 的模型，或按设计文档 §17 的说明删掉 §5.4 自评链路。
- 报错提到 `image_url` 不支持 → 模型看不见图，自评链路失效，同上。

- [ ] **Step 6: 提交**

探针脚本入库，样本不入库。

```bash
git add scripts/probe-providers.mjs .env.example .gitignore
git commit -m "chore: add provider capability probe"
```

---

### Task 2: 对象存储

**Files:**
- Modify: `compose.yaml`
- Create: `src/infrastructure/storage/asset-storage.mjs`
- Create: `src/infrastructure/storage/s3-asset-storage.mjs`
- Create: `test-integration/asset-storage.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: 无
- Produces:
  - `assertAssetStorage(storage)` — 校验实现完整性，缺方法抛 `TypeError`
  - `buildAssetKey({ ownerId, projectId, assetId, contentType }) => string`
  - `createS3AssetStorage({ endpoint, bucket, accessKey, secretKey, region, forcePathStyle })` 返回
    `{ put(key, bytes, contentType) => Promise<void>, get(key) => Promise<{ bytes: Buffer, contentType: string }>, getSignedUrl(key, { expiresInSeconds }) => Promise<string> }`

- [ ] **Step 1: 装依赖**

两个包必须**版本一致**，否则 presigner 与 client 的内部签名接口可能不兼容：

```bash
npm install --save-exact @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
node -e "const d=require('./package.json').dependencies;console.log(d['@aws-sdk/client-s3'], d['@aws-sdk/s3-request-presigner'])"
```

预期：两行输出版本号相同且无 `^` 前缀。若不同，用 `npm install --save-exact @aws-sdk/s3-request-presigner@<client 的版本>` 对齐。

- [ ] **Step 2: compose 加 MinIO**

`compose.yaml` 的 `services` 下追加，并在 `volumes` 下追加 `photo_agent_minio:`：

```yaml
  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: photoagent
      MINIO_ROOT_PASSWORD: photoagent123
    ports:
      - "9000:9000"
      - "9001:9001"
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 3s
      timeout: 3s
      retries: 20
    volumes:
      - photo_agent_minio:/data
```

`package.json` 的 scripts 里把 `db:up` 换成同时拉起两个服务，并保留旧名以免破坏现有习惯：

```json
"db:up": "docker compose up -d postgres",
"dev:up": "docker compose up -d postgres minio",
"dev:down": "docker compose down"
```

- [ ] **Step 3: 写失败测试**

创建 `test-integration/asset-storage.test.mjs`：

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildAssetKey,
} from '../src/infrastructure/storage/asset-storage.mjs';
import { createS3AssetStorage } from '../src/infrastructure/storage/s3-asset-storage.mjs';

function createStorage() {
  return createS3AssetStorage({
    endpoint: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9000',
    bucket: process.env.S3_BUCKET ?? 'photo-agent-test',
    accessKey: process.env.S3_ACCESS_KEY ?? 'photoagent',
    secretKey: process.env.S3_SECRET_KEY ?? 'photoagent123',
    region: process.env.S3_REGION ?? 'us-east-1',
    forcePathStyle: true,
  });
}

test('buildAssetKey nests by owner and project and derives the extension', () => {
  assert.equal(
    buildAssetKey({
      ownerId: 'dev',
      projectId: 'p1',
      assetId: 'a1',
      contentType: 'image/webp',
    }),
    'users/dev/projects/p1/a1.webp',
  );
  assert.equal(
    buildAssetKey({
      ownerId: 'dev',
      projectId: 'p1',
      assetId: 'a2',
      contentType: 'image/jpeg',
    }),
    'users/dev/projects/p1/a2.jpg',
  );
});

test('buildAssetKey rejects a content type it cannot map', () => {
  assert.throws(
    () =>
      buildAssetKey({
        ownerId: 'dev',
        projectId: 'p1',
        assetId: 'a3',
        contentType: 'application/pdf',
      }),
    /Unsupported image content type/,
  );
});

test('put and get round-trip the exact bytes', async () => {
  const storage = createStorage();
  const key = buildAssetKey({
    ownerId: 'dev',
    projectId: 'roundtrip',
    assetId: `a-${Date.now()}`,
    contentType: 'image/png',
  });
  const bytes = Buffer.from('not-really-a-png-but-bytes-are-bytes');

  await storage.put(key, bytes, 'image/png');
  const fetched = await storage.get(key);

  assert.deepEqual(fetched.bytes, bytes);
  assert.equal(fetched.contentType, 'image/png');
});

test('getSignedUrl returns a URL that serves the object without credentials', async () => {
  const storage = createStorage();
  const key = buildAssetKey({
    ownerId: 'dev',
    projectId: 'signed',
    assetId: `a-${Date.now()}`,
    contentType: 'image/png',
  });
  const bytes = Buffer.from('signed-content');
  await storage.put(key, bytes, 'image/png');

  const url = await storage.getSignedUrl(key, { expiresInSeconds: 60 });
  const response = await fetch(url);

  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
});
```

- [ ] **Step 4: 跑测试确认失败**

```bash
npm run dev:up
node --test test-integration/asset-storage.test.mjs
```

预期：FAIL，`Cannot find module '.../asset-storage.mjs'`。

- [ ] **Step 5: 写 asset-storage.mjs**

```js
/**
 * 对象存储 Port。只定义契约与不依赖具体实现的辅助。
 *
 * 不提供 delete()：垃圾回收是 non-goal（设计文档 §16），
 * MVP 无人调用，加一个死方法会让人以为清理逻辑已经存在。
 */

const EXTENSION_BY_CONTENT_TYPE = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/webp', 'webp'],
]);

const REQUIRED_METHODS = ['put', 'get', 'getSignedUrl'];

export function assertAssetStorage(storage) {
  for (const method of REQUIRED_METHODS) {
    if (typeof storage?.[method] !== 'function') {
      throw new TypeError(`Asset storage must implement ${method}()`);
    }
  }
  return storage;
}

/**
 * 对象键按 users/{ownerId}/projects/{projectId}/{assetId}.{ext} 组织。
 * 扩展名由 content type 推导，不写死 .png——图像模型可能返回 webp 或 jpeg，
 * 写死会让文件名骗人（设计文档 §6.2）。
 */
export function buildAssetKey({ ownerId, projectId, assetId, contentType }) {
  for (const [name, value] of Object.entries({ ownerId, projectId, assetId, contentType })) {
    if (typeof value !== 'string' || value === '') {
      throw new TypeError(`buildAssetKey requires a non-empty ${name}`);
    }
  }
  const extension = EXTENSION_BY_CONTENT_TYPE.get(contentType.toLowerCase());
  if (!extension) {
    throw new TypeError(`Unsupported image content type: ${contentType}`);
  }
  return `users/${ownerId}/projects/${projectId}/${assetId}.${extension}`;
}
```

- [ ] **Step 6: 写 s3-asset-storage.mjs**

```js
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl as presign } from '@aws-sdk/s3-request-presigner';

import { assertAssetStorage } from './asset-storage.mjs';

/**
 * S3 兼容实现，同一套代码覆盖 MinIO / 阿里云 OSS / 腾讯 COS。
 * forcePathStyle 对 MinIO 必须为 true（它不支持 virtual-host 风格的 bucket 域名）。
 */
export function createS3AssetStorage({
  endpoint,
  bucket,
  accessKey,
  secretKey,
  region = 'us-east-1',
  forcePathStyle = true,
}) {
  if (!bucket) throw new TypeError('createS3AssetStorage requires a bucket');

  const client = new S3Client({
    endpoint,
    region,
    forcePathStyle,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  });

  let ensured;
  /** MinIO 首次使用时 bucket 可能不存在；生产的 OSS/COS 一般已建好，HeadBucket 成功即跳过。 */
  async function ensureBucket() {
    ensured ??= (async () => {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
      }
    })();
    return ensured;
  }

  return assertAssetStorage({
    async put(key, bytes, contentType) {
      await ensureBucket();
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentType: contentType,
        }),
      );
    },

    async get(key) {
      await ensureBucket();
      const result = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      const chunks = [];
      for await (const chunk of result.Body) chunks.push(chunk);
      return {
        bytes: Buffer.concat(chunks),
        contentType: result.ContentType,
      };
    },

    async getSignedUrl(key, { expiresInSeconds = 900 } = {}) {
      await ensureBucket();
      return presign(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
        expiresIn: expiresInSeconds,
      });
    },
  });
}
```

- [ ] **Step 7: 跑测试确认通过**

```bash
node --test test-integration/asset-storage.test.mjs
```

预期：4 个用例 PASS。

- [ ] **Step 8: 确认集成测试整体仍绿**

```bash
npm run test:integration
```

预期：`# fail 0`。新文件与切片 1 的两个文件串行执行，互不干扰。

- [ ] **Step 9: 提交**

```bash
git add package.json package-lock.json compose.yaml \
        src/infrastructure/storage/ test-integration/asset-storage.test.mjs
git commit -m "feat: add s3-compatible asset storage"
```

---

### Task 3: 自定义 ImagesProvider

**照 `.probe/images.json` 的真实字段写解析，不照文档猜。**

**Files:**
- Create: `src/infrastructure/models/relay-images-provider.mjs`
- Create: `test/relay-images-provider.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `relayGenerateImages(model, context, options) => Promise<AssistantImages>`（pi 的 `ImagesFunction`）
  - `createRelayImagesModels({ baseUrl, modelId }) => ImagesModels`
    （**不收 apiKey**：key 由 provider 的 `auth: envApiKeyAuth(..., ['IMAGE_API_KEY'])` 从环境读取，
    `ImagesModels` 调度时注入到 `options.apiKey`）

- [ ] **Step 1: 写失败测试**

创建 `test/relay-images-provider.test.mjs`：

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { relayGenerateImages } from '../src/infrastructure/models/relay-images-provider.mjs';

const MODEL = {
  id: 'gpt-image-2',
  name: 'GPT Image 2',
  api: 'relay-openai-images',
  provider: 'relay',
  baseUrl: 'https://relay.example.com',
  input: ['text', 'image'],
  output: ['image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const PNG_B64 = 'iVBORw0KGgo=';

function contextWith(text, imageBase64) {
  const input = [{ type: 'text', text }];
  if (imageBase64) {
    input.push({ type: 'image', data: imageBase64, mimeType: 'image/png' });
  }
  return { input };
}

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return { fetchImpl, calls };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('sends multipart to /v1/images/edits with the base image attached', async () => {
  const { fetchImpl, calls } = fakeFetch(() =>
    jsonResponse(200, { data: [{ b64_json: PNG_B64 }] }),
  );

  await relayGenerateImages(MODEL, contextWith('海边黄昏', PNG_B64), {
    apiKey: 'k',
    fetch: fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://relay.example.com/v1/images/edits');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer k');
  const form = calls[0].init.body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get('model'), 'gpt-image-2');
  assert.equal(form.get('prompt'), '海边黄昏');
  assert.ok(form.get('image'), 'base image must be attached');
});

test('falls back to /v1/images/generations when no base image is given', async () => {
  const { fetchImpl, calls } = fakeFetch(() =>
    jsonResponse(200, { data: [{ b64_json: PNG_B64 }] }),
  );

  await relayGenerateImages(MODEL, contextWith('凭空生成一张'), {
    apiKey: 'k',
    fetch: fetchImpl,
  });

  assert.equal(calls[0].url, 'https://relay.example.com/v1/images/generations');
});

test('parses a b64_json response into ImageContent', async () => {
  const { fetchImpl } = fakeFetch(() =>
    jsonResponse(200, { data: [{ b64_json: PNG_B64 }] }),
  );

  const result = await relayGenerateImages(MODEL, contextWith('x', PNG_B64), {
    apiKey: 'k',
    fetch: fetchImpl,
  });

  assert.equal(result.stopReason, 'stop');
  assert.equal(result.output.length, 1);
  assert.deepEqual(result.output[0], {
    type: 'image',
    data: PNG_B64,
    mimeType: 'image/png',
  });
});

test('downloads a url response and converts it to base64', async () => {
  const { fetchImpl } = fakeFetch((url) => {
    if (url.endsWith('/v1/images/edits')) {
      return jsonResponse(200, { data: [{ url: 'https://cdn.example.com/out.webp' }] });
    }
    return new Response(Buffer.from('webp-bytes'), {
      status: 200,
      headers: { 'Content-Type': 'image/webp' },
    });
  });

  const result = await relayGenerateImages(MODEL, contextWith('x', PNG_B64), {
    apiKey: 'k',
    fetch: fetchImpl,
  });

  assert.equal(result.output[0].mimeType, 'image/webp');
  assert.equal(
    Buffer.from(result.output[0].data, 'base64').toString(),
    'webp-bytes',
    '中转站返回的 URL 可能有时效，必须当场下载转存（设计文档 §17）',
  );
});

test('reports auth failures as a fatal error result instead of throwing', async () => {
  const { fetchImpl } = fakeFetch(() =>
    jsonResponse(401, { error: { message: 'invalid api key' } }),
  );

  const result = await relayGenerateImages(MODEL, contextWith('x', PNG_B64), {
    apiKey: 'bad',
    fetch: fetchImpl,
  });

  assert.equal(result.stopReason, 'error');
  assert.match(result.errorMessage, /invalid api key/);
  assert.equal(result.output.length, 0);
});

test('reports rate limiting as an error result', async () => {
  const { fetchImpl } = fakeFetch(() => jsonResponse(429, { error: { message: 'slow down' } }));

  const result = await relayGenerateImages(MODEL, contextWith('x', PNG_B64), {
    apiKey: 'k',
    fetch: fetchImpl,
  });

  assert.equal(result.stopReason, 'error');
  assert.match(result.errorMessage, /slow down/);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test test/relay-images-provider.test.mjs
```

预期：FAIL，`Cannot find module '.../relay-images-provider.mjs'`。

- [ ] **Step 3: 写 relay-images-provider.mjs**

```js
import { createImagesModels, createImagesProvider, envApiKeyAuth } from '@earendil-works/pi-ai';

const API_ID = 'relay-openai-images';
const DEFAULT_MIME = 'image/png';

function splitInput(context) {
  const texts = [];
  let image;
  for (const item of context.input ?? []) {
    if (item.type === 'text') texts.push(item.text);
    else if (item.type === 'image' && !image) image = item;
  }
  return { prompt: texts.join('\n'), image };
}

/** 中转站可能回 b64_json 也可能回 url；url 有时效，必须当场下载转存。 */
async function toImageContent(entry, fetchImpl) {
  if (entry.b64_json) {
    return { type: 'image', data: entry.b64_json, mimeType: DEFAULT_MIME };
  }
  if (entry.url) {
    const response = await fetchImpl(entry.url);
    if (!response.ok) {
      throw new Error(`Failed to download generated image: HTTP ${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      type: 'image',
      data: bytes.toString('base64'),
      mimeType: response.headers.get('content-type') ?? DEFAULT_MIME,
    };
  }
  throw new Error(`Image response entry has neither b64_json nor url: ${Object.keys(entry)}`);
}

/**
 * pi 的 ImagesFunction。契约要求**不抛异常**——失败编码进返回值的
 * stopReason/errorMessage，由 Worker 侧按设计文档 §9.1 归类为可纠正 / 不可纠正。
 */
export const relayGenerateImages = async (model, context, options = {}) => {
  const base = {
    api: model.api,
    provider: model.provider,
    model: model.id,
    output: [],
    stopReason: 'stop',
    timestamp: Date.now(),
  };

  try {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const apiKey = options.apiKey;
    if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);

    const { prompt, image } = splitInput(context);
    const endpoint = image ? '/v1/images/edits' : '/v1/images/generations';

    const form = new FormData();
    form.set('model', model.id);
    form.set('prompt', prompt);
    if (image) {
      form.set(
        'image',
        new Blob([Buffer.from(image.data, 'base64')], { type: image.mimeType }),
        'base.png',
      );
    }

    const response = await fetchImpl(`${model.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      ...(options.signal ? { signal: options.signal } : {}),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = payload?.error?.message ?? `HTTP ${response.status}`;
      return { ...base, stopReason: 'error', errorMessage: detail };
    }

    const entries = payload?.data ?? [];
    const output = [];
    for (const entry of entries) output.push(await toImageContent(entry, fetchImpl));

    return { ...base, output, responseId: payload?.id };
  } catch (error) {
    if (error?.name === 'AbortError') {
      return { ...base, stopReason: 'aborted', errorMessage: 'Image generation aborted' };
    }
    return {
      ...base,
      stopReason: 'error',
      errorMessage: error?.message ?? String(error),
    };
  }
};

/**
 * 不使用 registerImagesApiProvider：createImagesProvider 自带 generateImages，
 * ImagesModels 调度时直接派发到 provider，无需全局注册表，也避免引入
 * 内置 openrouter provider 的副作用导入（设计文档 §4.2）。
 */
export function createRelayImagesModels({ baseUrl, modelId }) {
  const models = createImagesModels();
  models.setProvider(
    createImagesProvider({
      id: 'relay',
      name: 'Image Relay',
      auth: { apiKey: envApiKeyAuth('Image relay API key', ['IMAGE_API_KEY']) },
      models: [
        {
          id: modelId,
          name: modelId,
          api: API_ID,
          provider: 'relay',
          baseUrl,
          input: ['text', 'image'],
          output: ['image'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      api: { generateImages: relayGenerateImages },
    }),
  );
  return models;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
node --test test/relay-images-provider.test.mjs
```

预期：6 个用例 PASS。

- [ ] **Step 5: 对照探针样本校正**

打开 `.probe/images.json`，确认 `data[0]` 的字段名与测试里假设的 `b64_json` / `url` 一致。

**若字段名不同**（例如中转站回的是 `image` 或 `b64`），改 `toImageContent` 并在 `test/relay-images-provider.test.mjs` 里补一个对应的用例，不要只改实现。

- [ ] **Step 6: 提交**

```bash
git add src/infrastructure/models/relay-images-provider.mjs test/relay-images-provider.test.mjs
git commit -m "feat: add relay images provider"
```

---

### Task 4: 配置与 stdout telemetry

**Files:**
- Create: `src/config.mjs`
- Create: `src/infrastructure/models/llm-provider.mjs`
- Create: `src/infrastructure/telemetry/stdout-telemetry.mjs`
- Create: `test/config.test.mjs`
- Create: `test/stdout-telemetry.test.mjs`

**Interfaces:**
- Consumes: `createRelayImagesModels`（Task 3）
- Produces:
  - `loadWorkerConfig(env) => { databaseUrl, llm, image, s3, guards, telemetry }`，缺必填项抛 `Error`
    - `llm = { baseUrl, apiKey, modelId }`、`image = { baseUrl, apiKey, modelId }`
    - `s3 = { endpoint, bucket, accessKey, secretKey, region }`
    - `guards = { maxImagesPerTurn, imageTimeoutMs, turnTimeoutMs }`
  - `loadApiConfig(env) => { databaseUrl, port, s3 }`
  - `createLlmModels({ baseUrl, modelId }) => Models`
  - `createStdoutTelemetry({ write, now }) => TelemetryContext`（两者都可选，默认写 stdout / `Date.now`）

- [ ] **Step 1: 写失败测试**

创建 `test/config.test.mjs`：

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadApiConfig, loadWorkerConfig } from '../src/config.mjs';

const FULL_WORKER_ENV = {
  LLM_API_KEY: 'llm-key',
  IMAGE_BASE_URL: 'https://relay.example.com',
  IMAGE_API_KEY: 'image-key',
  S3_ACCESS_KEY: 'ak',
  S3_SECRET_KEY: 'sk',
};

test('worker config applies documented defaults', () => {
  const config = loadWorkerConfig(FULL_WORKER_ENV);
  assert.equal(config.llm.baseUrl, 'https://api.deepseek.com');
  assert.equal(config.llm.modelId, 'deepseek-v4-flash-vision-exp');
  assert.equal(config.image.modelId, 'gpt-image-2');
  assert.equal(config.guards.maxImagesPerTurn, 3);
  assert.equal(config.guards.imageTimeoutMs, 180000);
  assert.equal(config.telemetry, 'stdout');
});

test('worker config fails fast on every missing credential', () => {
  for (const missing of Object.keys(FULL_WORKER_ENV)) {
    const env = { ...FULL_WORKER_ENV };
    delete env[missing];
    assert.throws(
      () => loadWorkerConfig(env),
      new RegExp(missing),
      `${missing} must be required`,
    );
  }
});

test('api config does not require model credentials', () => {
  const config = loadApiConfig({ S3_ACCESS_KEY: 'ak', S3_SECRET_KEY: 'sk' });
  assert.equal(config.port, 3000);
  assert.equal(config.s3.accessKey, 'ak');
  assert.ok(!('llm' in config), 'API does not load the agent, so it needs no LLM credentials');
});

test('api config still requires object storage credentials for signed urls', () => {
  assert.throws(() => loadApiConfig({ S3_ACCESS_KEY: 'ak' }), /S3_SECRET_KEY/);
});

test('numeric guards reject non-numeric values instead of silently using NaN', () => {
  assert.throws(
    () => loadWorkerConfig({ ...FULL_WORKER_ENV, MAX_IMAGES_PER_TURN: 'many' }),
    /MAX_IMAGES_PER_TURN/,
  );
});
```

创建 `test/stdout-telemetry.test.mjs`：

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createStdoutTelemetry } from '../src/infrastructure/telemetry/stdout-telemetry.mjs';

function collector() {
  const lines = [];
  return { lines, write: (line) => lines.push(line) };
}

test('emits one JSON line per finished span with a duration', () => {
  const sink = collector();
  const telemetry = createStdoutTelemetry({ write: sink.write, now: () => 1000 });

  const span = telemetry.startSpan('pi.harness.tool', {
    attributes: { 'pi.tool.name': 'generate_image' },
  });
  span.end();

  assert.equal(sink.lines.length, 1);
  const parsed = JSON.parse(sink.lines[0]);
  assert.equal(parsed.span, 'pi.harness.tool');
  assert.equal(parsed.attributes['pi.tool.name'], 'generate_image');
  assert.equal(typeof parsed.durationMs, 'number');
});

test('every emitted line is valid JSON so the stream stays jq-parseable', () => {
  const sink = collector();
  const telemetry = createStdoutTelemetry({ write: sink.write, now: () => 0 });

  telemetry.startSpan('pi.ai.request', {
    attributes: { 'pi.ai.operation': 'generate_images' },
  }).end();

  for (const line of sink.lines) {
    assert.doesNotThrow(() => JSON.parse(line), `not JSON: ${line}`);
  }
});

test('records error status on the emitted line', () => {
  const sink = collector();
  const telemetry = createStdoutTelemetry({ write: sink.write, now: () => 0 });

  const span = telemetry.startSpan('pi.harness.run', {});
  span.setStatus({ code: 'error', message: 'provider unavailable' });
  span.end();

  const parsed = JSON.parse(sink.lines[0]);
  assert.equal(parsed.status.code, 'error');
  assert.equal(parsed.status.message, 'provider unavailable');
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test test/config.test.mjs test/stdout-telemetry.test.mjs
```

预期：两个文件都因模块不存在而 FAIL。

- [ ] **Step 3: 写 config.mjs**

```js
/**
 * 启动配置。**校验排在最前**——一个变量都不缺再去连数据库或建客户端，
 * 否则会在跑完其他初始化之后才失败，浪费启动时间并可能留下半初始化状态
 * （设计文档 §12.3）。
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
    databaseUrl:
      env.DATABASE_URL ??
      'postgres://photo_agent:photo_agent@127.0.0.1:54329/photo_agent',
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
    databaseUrl:
      env.DATABASE_URL ??
      'postgres://photo_agent:photo_agent@127.0.0.1:54329/photo_agent',
    port: integer(env, 'PORT', 3000),
    s3: s3Config(env),
  };
}
```

- [ ] **Step 4: 写 llm-provider.mjs**

```js
import { createModels, createProvider, envApiKeyAuth } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

/**
 * 文本模型接线。**不用 pi 内置的 deepseekProvider()**——pi 的模型目录是构建时
 * 从供应商拉取生成的，实验版模型不在快照里，getModel() 会返回 undefined。
 * 手写 Model 字面量，把能力显式声明出来（设计文档 §4.1）。
 *
 * input 必须含 'image'：Agent 要看见生成的图做自评（§5.4）。
 */
export function createLlmModels({ baseUrl, modelId }) {
  const models = createModels();
  models.setProvider(
    createProvider({
      id: 'deepseek',
      name: 'DeepSeek',
      baseUrl,
      auth: { apiKey: envApiKeyAuth('DeepSeek API key', ['LLM_API_KEY']) },
      models: [
        {
          id: modelId,
          name: modelId,
          api: 'openai-completions',
          provider: 'deepseek',
          baseUrl,
          reasoning: false,
          input: ['text', 'image'],
          contextWindow: 128_000,
          maxTokens: 8192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      api: openAICompletionsApi(),
    }),
  );
  return models;
}
```

- [ ] **Step 5: 写 stdout-telemetry.mjs**

```js
/**
 * 最简 TelemetryContext adapter：每个结束的 span 输出一行结构化 JSON。
 *
 * pi 的 telemetry 包只定义契约，不带 exporter（设计文档 §11.3）。
 * Session 记「Agent 做了什么」，span 记「花了多久、在哪一层失败」——
 * 生图延迟与供应商级失败只在 span 里有（§11.4）。
 *
 * stdout 只走 JSON 行，人类可读日志走 stderr，否则 smoke:e2e 的输出无法 | jq（§12.3）。
 */
export function createStdoutTelemetry({
  write = (line) => process.stdout.write(`${line}\n`),
  now = () => Date.now(),
} = {}) {
  function startSpan(name, options = {}) {
    const startedAt = now();
    const attributes = { ...(options.attributes ?? {}) };
    let status = { code: 'ok' };
    const events = [];

    const span = {
      setAttribute(key, value) {
        attributes[key] = value;
        return span;
      },
      setAttributes(next) {
        Object.assign(attributes, next);
        return span;
      },
      addEvent(eventName, eventAttributes) {
        events.push({ name: eventName, attributes: eventAttributes ?? {} });
        return span;
      },
      setStatus(next) {
        status = next;
        return span;
      },
      startSpan(childName, childOptions) {
        return startSpan(childName, childOptions);
      },
      end(endAttributes) {
        if (endAttributes) Object.assign(attributes, endAttributes);
        write(
          JSON.stringify({
            span: name,
            durationMs: now() - startedAt,
            attributes,
            status,
            ...(events.length ? { events } : {}),
          }),
        );
      },
    };
    return span;
  }

  return { startSpan };
}
```

- [ ] **Step 6: 跑测试确认通过**

```bash
node --test test/config.test.mjs test/stdout-telemetry.test.mjs
```

预期：8 个用例全部 PASS。

- [ ] **Step 7: 对照 pi 的 TelemetryContext 契约校验**

```bash
node -e "
import('@earendil-works/pi-agent-core').then(async (pi) => {
  const { createStdoutTelemetry } = await import('./src/infrastructure/telemetry/stdout-telemetry.mjs');
  const mine = createStdoutTelemetry({ write: () => {} });
  const reference = pi.InMemoryTelemetryContext ? new pi.InMemoryTelemetryContext() : null;
  if (!reference) { console.log('SKIP: InMemoryTelemetryContext not exported'); return; }
  const missing = Object.keys(reference).filter((k) => typeof reference[k] === 'function' && typeof mine[k] !== 'function');
  console.log(missing.length ? 'MISSING: ' + missing.join(', ') : 'contract ok');
});
"
```

预期：`contract ok`。若输出 `MISSING:`，把缺的方法补进 `createStdoutTelemetry` 并加对应单测。

- [ ] **Step 8: 提交**

```bash
git add src/config.mjs src/infrastructure/models/llm-provider.mjs \
        src/infrastructure/telemetry/stdout-telemetry.mjs \
        test/config.test.mjs test/stdout-telemetry.test.mjs
git commit -m "feat: add runtime config, llm provider and stdout telemetry"
```

---

### Task 5: 真实生图落 MinIO

本切片的验收线：一条命令，真出图，图在 MinIO 里能看见。

**Files:**
- Create: `scripts/smoke-image.mjs`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: `loadWorkerConfig`、`createRelayImagesModels`、`createS3AssetStorage`、`buildAssetKey`、`createStdoutTelemetry`
- Produces: 无

- [ ] **Step 1: 写冒烟脚本**

创建 `scripts/smoke-image.mjs`：

```js
// 真实生图冒烟。手动执行，会产生费用，不进 CI。
// 人类可读日志走 stderr，stdout 只留 telemetry 的 JSON 行（设计文档 §12.3）。
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { loadWorkerConfig } from '../src/config.mjs';
import { createRelayImagesModels } from '../src/infrastructure/models/relay-images-provider.mjs';
import {
  buildAssetKey,
} from '../src/infrastructure/storage/asset-storage.mjs';
import { createS3AssetStorage } from '../src/infrastructure/storage/s3-asset-storage.mjs';

const log = (message) => process.stderr.write(`${message}\n`);

const config = loadWorkerConfig();
const [inputPath, ...promptParts] = process.argv.slice(2);
if (!inputPath) {
  log('Usage: node --env-file=.env scripts/smoke-image.mjs <image-path> [prompt...]');
  process.exit(1);
}
const prompt = promptParts.join(' ') || '把背景换成海边沙滩，保持人物面部特征不变';

const storage = createS3AssetStorage(config.s3);
const imagesModels = createRelayImagesModels({
  baseUrl: config.image.baseUrl,
  modelId: config.image.modelId,
});

const baseBytes = await readFile(inputPath);
log(`base image: ${inputPath} (${baseBytes.length} bytes)`);
log(`prompt: ${prompt}`);
log(`model: ${config.image.modelId} @ ${config.image.baseUrl}`);

const model = imagesModels.getModel('relay', config.image.modelId);
if (!model) throw new Error(`Model not registered: ${config.image.modelId}`);

const startedAt = Date.now();
const result = await imagesModels.generateImages(
  model,
  {
    input: [
      { type: 'text', text: prompt },
      { type: 'image', data: baseBytes.toString('base64'), mimeType: 'image/png' },
    ],
  },
  { timeoutMs: config.guards.imageTimeoutMs },
);
log(`elapsed: ${Date.now() - startedAt}ms  stopReason: ${result.stopReason}`);

if (result.stopReason !== 'stop') {
  log(`FAILED: ${result.errorMessage}`);
  process.exit(1);
}

const image = result.output.find((item) => item.type === 'image');
if (!image) {
  log('FAILED: response contained no image');
  process.exit(1);
}

const assetId = randomUUID();
const key = buildAssetKey({
  ownerId: 'dev',
  projectId: 'smoke',
  assetId,
  contentType: image.mimeType,
});
await storage.put(key, Buffer.from(image.data, 'base64'), image.mimeType);
const url = await storage.getSignedUrl(key, { expiresInSeconds: 3600 });

log('');
log(`stored: ${key}`);
log(`signed url (1h): ${url}`);
log('MinIO console: http://127.0.0.1:9001  (photoagent / photoagent123)');
```

- [ ] **Step 2: 加脚本入口**

`package.json` 的 scripts 追加：

```json
"smoke:image": "node --env-file=.env scripts/smoke-image.mjs"
```

- [ ] **Step 3: 准备一张基准图并运行**

```bash
npm run dev:up
# 任意一张人像 png，或用系统自带图片
npm run smoke:image -- ./sample.png "把背景换成海边沙滩，保持人物面部特征不变"
```

- [ ] **Step 4: 验证三件事**

1. stderr 打印 `stopReason: stop` 且 elapsed 在合理区间（通常 30–90 秒）
2. `stored:` 的键形如 `users/dev/projects/smoke/<uuid>.png`（或 `.webp`，取决于模型返回的 content type）
3. 打开签名 URL 能看到图；MinIO 控制台 `http://127.0.0.1:9001` 里对象存在

**若扩展名与实际格式不符**，说明 `image.mimeType` 取错了，回 Task 3 检查 `toImageContent` 的 content-type 处理。

- [ ] **Step 5: 确认自动化测试无回归**

```bash
npm test
npm run test:integration
npm run check
```

预期：全绿。冒烟脚本不进 CI，`npm test` 只跑 `test/*.test.mjs`。

- [ ] **Step 6: 更新 README**

「运行环境」一节的启动命令改为：

```bash
npm install
cp .env.example .env      # 填入 LLM_API_KEY / IMAGE_BASE_URL / IMAGE_API_KEY
npm run dev:up            # PostgreSQL + MinIO
npm run db:migrate
```

「当前限制」一节追加：

```text
- 图像供应商适配层已打通：基准图 + 指令可产出真实图片并落入 S3 兼容对象存储（`npm run smoke:image`）。Agent 尚未接线（切片 2c）。
```

- [ ] **Step 7: 提交**

```bash
git add scripts/smoke-image.mjs package.json README.md
git commit -m "feat: add real image generation smoke script"
```

---

## 切片 2a 完成标准

- [ ] `node --env-file=.env scripts/probe-providers.mjs` 跑通，且 `tool_calls` 非空——证明 function calling 与图片输入同时可用
- [ ] `npm test` 全绿（含新增的 provider / config / telemetry 单测）
- [ ] `npm run test:integration` 全绿（含 MinIO 往返，切片 1 的 conformance 30/30 不受影响）
- [ ] `npm run check` 通过
- [ ] `npm run smoke:image -- <图> "<指令>"` 产出真实图片，MinIO 控制台可见，签名 URL 可访问
- [ ] `src/domain/**`、`src/api/**`、`src/worker/**`、`migrations/**`、`src/infrastructure/postgres/**` 未被修改（`git diff --stat` 确认）
- [ ] 直接依赖新增不超过 3 个：`@earendil-works/pi-ai`、`@aws-sdk/client-s3`、`@aws-sdk/s3-request-presigner`

## 下一步

切片 2b（迁移 006–009 + domain 项目锁上移 + repository 方法改造）另起一份计划。它与本切片无依赖，可并行进行。
