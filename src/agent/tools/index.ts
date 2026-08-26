import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";

import type { PhotoProjectRepository } from "@/domain/photo-project";
import type { ImageGenerationProvider } from "@/infrastructure/models/image-provider";
import type { AssetStorageLike } from "@/infrastructure/storage/asset-storage";
import type { TelemetryContext } from "@/infrastructure/telemetry/stdout-telemetry";
import { createGenerateImageTool, type GenerateImageDetails } from "@/agent/tools/generate-image";
import type { ReadPhotoStateDetails } from "@/agent/tools/read-photo-state";
import type { SelectCandidateDetails } from "@/agent/tools/select-candidate";
import { createReadPhotoStateTool } from "@/agent/tools/read-photo-state";
import { createSelectCandidateTool } from "@/agent/tools/select-candidate";
import { createTurnContext, MaxImagesReachedError, MaxImageAttemptsReachedError } from "@/agent/tools/turn-context";
import type { TurnContext } from "@/agent/tools/turn-context";

export { createGenerateImageTool } from "@/agent/tools/generate-image";
export type { GenerateImageDetails } from "@/agent/tools/generate-image";
export { createReadPhotoStateTool } from "@/agent/tools/read-photo-state";
export { createSelectCandidateTool } from "@/agent/tools/select-candidate";
export { createTurnContext, MaxImagesReachedError, MaxImageAttemptsReachedError } from "@/agent/tools/turn-context";
export type { ReadPhotoStateDetails } from "@/agent/tools/read-photo-state";
export type { SelectCandidateDetails } from "@/agent/tools/select-candidate";
export type { TurnContext } from "@/agent/tools/turn-context";

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
