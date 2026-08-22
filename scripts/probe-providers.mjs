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

  const response = await fetch(`${required('LLM_BASE_URL')}/v1/chat/completions`, {
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

  const response = await fetch(`${required('IMAGE_BASE_URL')}/v1/images/edits`, {
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

process.stdout.write('\nSamples written to .probe/ (git-ignored).\n');
