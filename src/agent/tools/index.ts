import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";

import type { PhotoProjectRepository } from "../../domain/photo-project.js";
import type { ImageGenerationProvider } from "../../infrastructure/models/image-provider.js";
import type { AssetStorageLike } from "../../infrastructure/storage/asset-storage.js";
import type { TelemetryContext } from "../../infrastructure/telemetry/stdout-telemetry.js";
import { createGenerateImageTool, type GenerateImageDetails } from "./generate-image.js";
import type { ReadPhotoStateDetails } from "./read-photo-state.js";
import type { SelectCandidateDetails } from "./select-candidate.js";
import { createReadPhotoStateTool } from "./read-photo-state.js";
import { createSelectCandidateTool } from "./select-candidate.js";
import { createTurnContext, MaxImagesReachedError, MaxImageAttemptsReachedError } from "./turn-context.js";
import type { TurnContext } from "./turn-context.js";

export { createGenerateImageTool } from "./generate-image.js";
export type { GenerateImageDetails } from "./generate-image.js";
export { createReadPhotoStateTool } from "./read-photo-state.js";
export { createSelectCandidateTool } from "./select-candidate.js";
export { createTurnContext, MaxImagesReachedError, MaxImageAttemptsReachedError } from "./turn-context.js";
export type { ReadPhotoStateDetails } from "./read-photo-state.js";
export type { SelectCandidateDetails } from "./select-candidate.js";
export type { TurnContext } from "./turn-context.js";

/**
 * Agent 工具集的组装点：新增工具时在这里注册一次，
 * worker 组合根只依赖这个函数，不再逐个拼装工具数组。
 */
export function createAgentTools({
  repository,
  imageProvider,
  assetStorage,
  turnContext,
  config,
  telemetry,
}: {
  repository: Pick<PhotoProjectRepository, "getRevision" | "recordGeneration" | "getAsset" | "selectCandidate">;
  imageProvider: ImageGenerationProvider;
  assetStorage: Pick<AssetStorageLike, "put" | "get" | "bucket">;
  turnContext: TurnContext;
  config: { guards: { maxImagesPerTurn: number; maxImageAttemptsPerTurn: number } };
  telemetry?: TelemetryContext;
}): AgentTool<TSchema, GenerateImageDetails | ReadPhotoStateDetails | SelectCandidateDetails>[] {
  return [
    createReadPhotoStateTool({ repository, turnContext }),
    createGenerateImageTool({ repository, imageProvider, assetStorage, turnContext, config, telemetry }),
    createSelectCandidateTool({ repository, turnContext }),
  ];
}
