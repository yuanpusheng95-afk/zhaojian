// 真实供应商探针。手动执行，会产生极少量费用。
//
// 目的：把两个只能靠实物确定的行为打出来存样本，供后续解析代码照着写。
//   1. 文本模型能否在带图片输入时正常返回 tool_calls
//   2. 图像中转站 /v1/images/edits 的真实响应字段名
//
// 用法：node --env-file=.env scripts/probe-providers.mjs
import { mkdir, writeFile } from 'node:fs/promises';

const OUT = new URL('../.probe/', import.meta.url);

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

/**
 * 拼接 API 路径，容忍 base URL 带不带 /v1。
 * 中转站的 base URL 写法不统一（https://x.com 与 https://x.com/v1 都常见），
 * 不做归一化就会拼出 /v1/v1/...。
 */
function apiUrl(baseUrl, path) {
  const base = baseUrl.replace(/\/+$/, '');
  return base.endsWith('/v1') ? `${base}${path}` : `${base}/v1${path}`;
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

  const response = await fetch(apiUrl(required('LLM_BASE_URL'), '/chat/completions'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${required('LLM_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
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

  const response = await fetch(apiUrl(required('IMAGE_BASE_URL'), '/images/edits'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${required('IMAGE_API_KEY')}` },
    body: form,
  });
  return { status: response.status, body: await response.json() };
}

/** 样本可能很大（b64 图片），截断后再存，只保留结构。 */
function summarize(value) {
  if (typeof value === 'string') {
    return value.length > 120 ? `${value.slice(0, 120)}…<${value.length} chars>` : value;
  }
  if (Array.isArray(value)) return value.map((item) => summarize(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, summarize(item)]),
    );
  }
  return value;
}

await mkdir(OUT, { recursive: true });

/** 两个探针互相独立：只配了一侧凭证时，另一侧的缺失不应中断整个探测。 */
async function run(label, probe, summarize_) {
  try {
    const result = await probe();
    await writeFile(
      new URL(`${label}.json`, OUT),
      JSON.stringify(summarize(result), null, 2),
    );
    process.stdout.write(`${label}: ${summarize_(result)}\n`);
  } catch (error) {
    process.stdout.write(`${label}: SKIPPED/FAILED — ${error.message}\n`);
  }
}

await run(
  'chat',
  probeChat,
  (result) => {
    const toolCalls = result.body?.choices?.[0]?.message?.tool_calls;
    return `status=${result.status} tool_calls=${toolCalls ? JSON.stringify(toolCalls) : 'NONE'}`;
  },
);

await run('images', probeImages, (result) => {
  const first = result.body?.data?.[0];
  return `status=${result.status} keys=${first ? Object.keys(first).join(',') : 'NONE'}`;
});

process.stdout.write('\nSamples written to .probe/ (git-ignored).\n');
