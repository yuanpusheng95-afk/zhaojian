/**
 * 图像生成供应商端口。工具层只面向此接口，不感知具体厂商的
 * 请求格式、重试策略和错误文案；新增供应商时实现一个 Adapter 即可，
 * 不需要修改 generate-image 工具。
 */

export interface ImageGenerationRequest {
  prompt: string;
  baseImage?: { data: string; mimeType: string } | null;
  size?: string;
  signal?: AbortSignal;
}

export interface GeneratedImage {
  data: string;
  mimeType: string;
}

/**
 * fatal = true 的失败会终止整个 agent turn（例如鉴权失效、配额耗尽）；
 * fatal = false 的失败作为普通工具错误抛出，agent 可以在尝试预算内重试。
 */
export interface ImageGenerationFailure {
  code: "IMAGE_PROVIDER_UNAUTHORIZED" | "IMAGE_PROVIDER_UNAVAILABLE" | "IMAGE_PROVIDER_ABORTED" | "IMAGE_PROVIDER_NO_OUTPUT";
  message: string;
  fatal: boolean;
}

export type ImageGenerationResult =
  | { ok: true; image: GeneratedImage }
  | { ok: false; failure: ImageGenerationFailure };

export interface ImageGenerationProvider {
  readonly modelId: string;
  generate(request: ImageGenerationRequest): Promise<ImageGenerationResult>;
}
