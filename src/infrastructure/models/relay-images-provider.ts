import {
  createImagesModels,
  createImagesProvider,
  envApiKeyAuth,
} from "@earendil-works/pi-ai";

import type {
  ImageGenerationFailure,
  ImageGenerationProvider,
  ImageGenerationResult,
} from "@/infrastructure/models/image-provider";

const API_ID = "relay-openai-images";
const DEFAULT_MIME = "image/png";
const DEFAULT_SIZE = "1024x1024";

// ---------------------------------------------------------------------------
// pi-ai 边界的本地类型：库的 model/context 是弱类型 API，这里收口成最小契约。
// ---------------------------------------------------------------------------

/** pi-ai 传给 generateImages 的输入项（我们只发 text 和 image）。 */
type ProviderInput =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface ProviderContext {
  input: ProviderInput[];
}

interface ProviderModel {
  id: string;
  provider: string;
  api: string;
  baseUrl: string;
}

interface ProviderImage {
  data: string;
  mimeType?: string;
}

/** relay 响应里可能出现的形状（chat choices / images data），按需取字段。 */
interface RelayResponsePayload {
  id?: string;
  choices?: Array<{ message?: { content?: unknown } }>;
  data?: Array<{ b64_json?: string }>;
  error?: { message?: string };
}

function apiUrl(baseUrl: string, path: string): string {
  const base = String(baseUrl).replace(/\/+$/, "");
  return base.endsWith("/v1") ? `${base}${path}` : `${base}/v1${path}`;
}

function splitInput(context: ProviderContext): { prompt: string; image?: ProviderImage } {
  const texts: string[] = [];
  let image: ProviderImage | undefined;
  for (const item of context.input ?? []) {
    if (item.type === "text") texts.push(item.text);
    else if (item.type === "image" && !image) image = item;
  }
  return { prompt: texts.join("\n"), image };
}

const DATA_URI_PATTERN = /!\[[^\]]*\]\(data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=]+)\)/g;

function parseMarkdownImages(content: unknown) {
  if (typeof content !== "string") return [];
  return [...content.matchAll(DATA_URI_PATTERN)].map((match) => ({
    type: "image" as const,
    data: match[2],
    mimeType: match[1],
  }));
}

function parseImagesApi(payload: RelayResponsePayload) {
  return (payload?.data ?? [])
    .filter((entry): entry is { b64_json: string } => Boolean(entry?.b64_json))
    .map((entry) => ({
      type: "image" as const,
      data: entry.b64_json,
      mimeType: DEFAULT_MIME,
    }));
}

async function readPayload(response: Response): Promise<RelayResponsePayload & { __raw?: string }> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { __raw: text.slice(0, 200) };
  }
}

function errorMessage(response: Response, payload: RelayResponsePayload & { __raw?: string }): string {
  return payload?.error?.message ?? payload?.__raw ?? `HTTP ${response.status}`;
}

interface RelayRequestOptions {
  apiKey: string;
  size?: string;
  editRoute?: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

function authHeaders(apiKey: string, contentType?: string): Record<string, string> {
  return contentType
    ? { Authorization: `Bearer ${apiKey}`, "Content-Type": contentType }
    : { Authorization: `Bearer ${apiKey}` };
}

/** chat completions 路由：把图片塞进 message content，响应里解析 markdown data URI。 */
async function sendChatEdit(
  fetchImpl: typeof fetch, baseUrl: string, modelId: string, apiKey: string,
  prompt: string, image: ProviderImage, signal?: AbortSignal,
): Promise<Response> {
  const mimeType = image.mimeType ?? DEFAULT_MIME;
  return fetchImpl(apiUrl(baseUrl, "/chat/completions"), {
    method: "POST",
    headers: authHeaders(apiKey, "application/json"),
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "user", content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: `data:${mimeType};base64,${image.data}` } },
      ] }],
    }),
    ...(signal ? { signal } : {}),
  });
}

/** images/edits 路由：multipart 表单。 */
async function sendMultipartEdit(
  fetchImpl: typeof fetch, baseUrl: string, modelId: string, apiKey: string,
  prompt: string, size: string, image: ProviderImage, signal?: AbortSignal,
): Promise<Response> {
  const mimeType = image.mimeType ?? DEFAULT_MIME;
  const form = new FormData();
  form.set("model", modelId);
  form.set("prompt", prompt);
  form.set("size", size);
  form.set("image", new Blob([Buffer.from(image.data, "base64")], { type: mimeType }), "base.png");
  return fetchImpl(apiUrl(baseUrl, "/images/edits"), {
    method: "POST",
    headers: authHeaders(apiKey),
    body: form,
    ...(signal ? { signal } : {}),
  });
}

/** 带退避的重试包装：5xx 重试最多 2 次；AbortError 直接上抛。 */
async function withRetries(
  send: () => Promise<Response>,
  maxRetries = 2,
): Promise<{ response: Response | null; lastError: string | number | undefined }> {
  let lastError: string | number | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (attempt > 0) await new Promise<void>((r) => setTimeout(r, 1000 * attempt));
    try {
      const response = await send();
      if (response.ok || response.status < 500) return { response, lastError };
      lastError = response.status;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { response: null, lastError };
}

/** 文生图路由：无重试，一次请求。 */
async function sendGenerationRequest(
  fetchImpl: typeof fetch, baseUrl: string, modelId: string, apiKey: string,
  prompt: string, size: string, signal?: AbortSignal,
): Promise<Response> {
  return fetchImpl(apiUrl(baseUrl, "/images/generations"), {
    method: "POST",
    headers: authHeaders(apiKey, "application/json"),
    body: JSON.stringify({ model: modelId, prompt, n: 1, size }),
    ...(signal ? { signal } : {}),
  });
}

/** pi-ai images API 的返回协议：stopReason/output/errorMessage 是库消费的字段。 */
export interface RelayGenerateResult {
  api: string;
  provider: string;
  model: string;
  output: Array<{ type: "image"; data: string; mimeType: string }>;
  stopReason: "stop" | "error" | "aborted";
  errorMessage?: string;
  responseId?: string;
  timestamp: number;
}

export const relayGenerateImages = async (
  weakModel: unknown, context: ProviderContext, options: Partial<RelayRequestOptions> = {},
): Promise<RelayGenerateResult> => {
  const model = weakModel as ProviderModel;
  const base = {
    api: model.api,
    provider: model.provider,
    model: model.id,
    output: [] as RelayGenerateResult["output"],
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };

  try {
    const opts = {
      size: DEFAULT_SIZE,
      editRoute: "chat",
      ...options,
    } as RelayRequestOptions & { apiKey: string };
    if (!opts.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
    const fetchImpl: typeof fetch = opts.fetch ?? globalThis.fetch;

    const { prompt, image } = splitInput(context);
    const size = opts.size ?? DEFAULT_SIZE;
    const signal = opts.signal;

    let response: Response | null;
    let viaChat = false;
    let lastError: string | number | undefined;

    if (image) {
      // 编辑路径：chat 路由或 multipart 路由，带重试
      viaChat = opts.editRoute !== "edits";
      const send = viaChat
        ? () => sendChatEdit(fetchImpl, model.baseUrl, model.id, opts.apiKey, prompt, image, signal)
        : () => sendMultipartEdit(fetchImpl, model.baseUrl, model.id, opts.apiKey, prompt, size, image, signal);
      ({ response, lastError } = await withRetries(send));
    } else {
      response = await sendGenerationRequest(fetchImpl, model.baseUrl, model.id, opts.apiKey, prompt, size, signal);
    }

    if (!response) {
      return { ...base, stopReason: "error", errorMessage: `Provider unavailable after retries (${lastError})` };
    }

    const payload = await readPayload(response);
    if (!response.ok && response.status < 500) {
      return { ...base, stopReason: "error", errorMessage: errorMessage(response, payload) };
    }
    if (!response.ok) {
      return { ...base, stopReason: "error", errorMessage: `Provider unavailable after retries (${response.status})` };
    }

    let finalOutput = viaChat
      ? parseMarkdownImages(payload?.choices?.[0]?.message?.content)
      : parseImagesApi(payload);
    if (finalOutput.length === 0) finalOutput = parseImagesApi(payload);
    if (finalOutput.length === 0) {
      return { ...base, stopReason: "error", errorMessage: "Provider returned no image in a successful response" };
    }

    return { ...base, output: finalOutput, responseId: payload?.id };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ...base, stopReason: "aborted", errorMessage: "Image generation aborted" };
    }
    return { ...base, stopReason: "error", errorMessage: error instanceof Error ? error.message : String(error) };
  }
};

export function createRelayImagesModels({ baseUrl, modelId }: { baseUrl: string; modelId: string }) {
  const models = createImagesModels();
  models.setProvider(
    createImagesProvider({
      id: "relay",
      name: "Image Relay",
      auth: { apiKey: envApiKeyAuth("Image relay API key", ["IMAGE_API_KEY"]) },
      models: [
        {
          id: modelId,
          name: modelId,
          api: API_ID,
          provider: "relay",
          baseUrl,
          input: ["text", "image"],
          output: ["image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        } as any,
      ],
      api: { generateImages: relayGenerateImages },
    }) as any,
  );
  return models;
}

function classifyRelayFailure(message: string): ImageGenerationFailure {
  const text = String(message).toLowerCase();
  if (text.includes("http 401") || text.includes("unauthorized")) {
    return { code: "IMAGE_PROVIDER_UNAUTHORIZED", message, fatal: true };
  }
  if (text.includes("quota") || text.includes("insufficient")) {
    return { code: "IMAGE_PROVIDER_UNAVAILABLE", message, fatal: true };
  }
  return { code: "IMAGE_PROVIDER_UNAVAILABLE", message, fatal: false };
}

export interface RelayImageProviderOptions {
  baseUrl: string;
  modelId: string;
  apiKey: string;
  size?: string;
  editRoute?: "chat" | "edits";
  fetch?: typeof fetch;
}

/** ImageGenerationProvider 端口的 relay 实现：封装请求路由、重试和错误分类。 */
export function createRelayImageProvider({
  baseUrl,
  modelId,
  apiKey,
  size = DEFAULT_SIZE,
  editRoute = "chat",
  fetch: fetchImpl,
}: RelayImageProviderOptions): ImageGenerationProvider {
  if (!apiKey) throw new TypeError("createRelayImageProvider requires an apiKey");

  const models = createRelayImagesModels({ baseUrl, modelId });
  const model = models.getModel("relay", modelId) as any;
  if (!model) throw new Error(`Relay image model is not registered: ${modelId}`);

  return {
    modelId,
    async generate(request) {
      const generated = await relayGenerateImages(model, {
        input: [
          { type: "text", text: request.prompt } as const,
          ...(request.baseImage
            ? [{ type: "image", data: request.baseImage.data, mimeType: request.baseImage.mimeType } as const]
            : []),
        ],
      }, {
        apiKey,
        size: request.size ?? size,
        editRoute,
        signal: request.signal,
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      });

      if (generated.stopReason === "aborted") {
        return {
          ok: false as const,
          failure: {
            code: "IMAGE_PROVIDER_ABORTED" as const,
            message: generated.errorMessage ?? "Image generation aborted",
            fatal: false,
          },
        };
      }
      if (generated.stopReason === "error" || !generated.output?.length) {
        return {
          ok: false as const,
          failure: classifyRelayFailure(generated.errorMessage ?? "Image provider returned no image"),
        };
      }
      const image = generated.output[0];
      return { ok: true as const, image: { data: image.data, mimeType: image.mimeType ?? DEFAULT_MIME } };
    },
  };
}
