import {
  createImagesModels,
  createImagesProvider,
  envApiKeyAuth,
} from '@earendil-works/pi-ai';

const API_ID = 'relay-openai-images';
const DEFAULT_MIME = 'image/png';
const DEFAULT_SIZE = '1024x1024';

/**
 * 拼接 API 路径，容忍 base URL 带不带 /v1。
 * 中转站的 base URL 写法不统一（https://x.com 与 https://x.com/v1 都常见），
 * 不做归一化就会拼出 /v1/v1/...。
 */
function apiUrl(baseUrl, path) {
  const base = String(baseUrl).replace(/\/+$/, '');
  return base.endsWith('/v1') ? `${base}${path}` : `${base}/v1${path}`;
}

function splitInput(context) {
  const texts = [];
  let image;
  for (const item of context.input ?? []) {
    if (item.type === 'text') texts.push(item.text);
    else if (item.type === 'image' && !image) image = item;
  }
  return { prompt: texts.join('\n'), image };
}

/**
 * 中转站的 img2img 把图片以 Markdown data URI 内嵌在 message.content 里，
 * 既不是 OpenRouter 的 message.images[]，也不是 OpenAI 的 data[].b64_json。
 * 形如：![image_1](data:image/png;base64,iVBORw0...)
 */
const DATA_URI_PATTERN = /!\[[^\]]*\]\(data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=]+)\)/g;

function parseMarkdownImages(content) {
  if (typeof content !== 'string') return [];
  return [...content.matchAll(DATA_URI_PATTERN)].map((match) => ({
    type: 'image',
    data: match[2],
    mimeType: match[1],
  }));
}

/** OpenAI Images API 风格：data[].b64_json。 */
function parseImagesApi(payload) {
  return (payload?.data ?? [])
    .filter((entry) => entry?.b64_json)
    .map((entry) => ({
      type: 'image',
      data: entry.b64_json,
      mimeType: DEFAULT_MIME,
    }));
}

async function readPayload(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    // Cloudflare 之类的边缘错误返回 text/plain，直接 .json() 会抛在解析上，
    // 把真正的状态码淹没掉
    return { __raw: text.slice(0, 200) };
  }
}

function errorMessage(response, payload) {
  return (
    payload?.error?.message ??
    payload?.__raw ??
    `HTTP ${response.status}`
  );
}

/**
 * pi 的 ImagesFunction。契约要求**不抛异常**——失败编码进返回值的
 * stopReason / errorMessage，由 Worker 侧按设计文档 §9.1 归类为可纠正 / 不可纠正。
 *
 * 三条路由，全部经真实中转站实测：
 *   有基准图 + editRoute=chat（默认） → /chat/completions，解 Markdown data URI
 *   有基准图 + editRoute=edits        → /images/edits，解 b64_json
 *   无基准图                           → /images/generations，解 b64_json
 *
 * size 必须显式指定：中转站内部默认填 auto，上游会超时并由边缘返回 502。
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
    const size = options.size ?? DEFAULT_SIZE;
    const editRoute = options.editRoute ?? 'chat';
    const signal = options.signal ? { signal: options.signal } : {};

    let response;
    let viaChat = false;

    if (image && editRoute === 'chat') {
      viaChat = true;
      response = await fetchImpl(apiUrl(model.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: model.id,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                {
                  type: 'image_url',
                  image_url: { url: `data:${image.mimeType};base64,${image.data}` },
                },
              ],
            },
          ],
        }),
        ...signal,
      });
    } else if (image) {
      const form = new FormData();
      form.set('model', model.id);
      form.set('prompt', prompt);
      form.set('size', size);
      form.set(
        'image',
        new Blob([Buffer.from(image.data, 'base64')], { type: image.mimeType }),
        'base.png',
      );
      response = await fetchImpl(apiUrl(model.baseUrl, '/images/edits'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        ...signal,
      });
    } else {
      response = await fetchImpl(apiUrl(model.baseUrl, '/images/generations'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: model.id, prompt, n: 1, size }),
        ...signal,
      });
    }

    const payload = await readPayload(response);
    if (!response.ok) {
      return { ...base, stopReason: 'error', errorMessage: errorMessage(response, payload) };
    }

    const output = viaChat
      ? parseMarkdownImages(payload?.choices?.[0]?.message?.content)
      : parseImagesApi(payload);

    if (output.length === 0) {
      // 中转站会以 200 返回一段不含图的文本（例如泄露的请求体片段）。
      // 静默当成功会让上层拿到空候选，必须显式判错。
      return {
        ...base,
        stopReason: 'error',
        errorMessage: 'Provider returned no image in a successful response',
      };
    }

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
