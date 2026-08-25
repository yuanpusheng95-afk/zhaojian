import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";

import { AssetNotFoundError } from "../../domain/photo-project-service.js";
import { ErrorCode } from "../../domain/errors.js";
import type { PhotoProjectRepository } from "../../domain/photo-project.js";
import { applyPhotoStatePatch, type StatePatch } from "../../domain/photo-state.js";
import type { ImageGenerationProvider } from "../../infrastructure/models/image-provider.js";
import { createNoopTelemetry } from "../../infrastructure/telemetry/stdout-telemetry.js";
import type { TelemetryContext } from "../../infrastructure/telemetry/stdout-telemetry.js";
import {
  InvalidAssetUriError,
  buildAssetKey,
  buildAssetUri,
  resolveAssetStorageKey,
} from "../../infrastructure/storage/asset-storage.js";
import { MaxImageAttemptsReachedError, MaxImagesReachedError } from "./turn-context.js";
import type { TurnContext } from "./turn-context.js";

/** 工具层致命错误：终止整个 agent turn，code 走 ErrorCode 常量。 */
export class ToolFatalError extends Error {
  readonly fatalCode: string;
  constructor(fatalCode: string, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "ToolFatalError";
    this.fatalCode = fatalCode;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

const EXTENSION_BY_MIME = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
]);

type GenerateImageRepository = Pick<PhotoProjectRepository, "getRevision" | "recordGeneration" | "getAsset">;

export interface GenerateImageParams {
  patch: Record<string, unknown>;
  renderPrompt: string;
}

export interface GenerateImageDetails {
  generationId?: string;
  candidateId?: string;
  assetId?: string;
  fatalCode?: string;
}

interface GenerateImageConfig {
  guards: { maxImagesPerTurn: number; maxImageAttemptsPerTurn: number };
}

export function createGenerateImageTool({
  repository, imageProvider, assetStorage, turnContext, config, telemetry = createNoopTelemetry(),
}: {
  repository: GenerateImageRepository;
  imageProvider: ImageGenerationProvider;
  assetStorage: { put(key: string, bytes: Buffer | Uint8Array, contentType: string): Promise<void>; get(key: string): Promise<{ bytes: Buffer; contentType?: string }>; bucket: string };
  turnContext: TurnContext;
  config: GenerateImageConfig;
  telemetry?: TelemetryContext;
}): AgentTool<TSchema, GenerateImageDetails> {
  async function readBaseImage() {
    let asset;
    try {
      asset = await repository.getAsset(turnContext.currentBaseAssetId!);
    } catch (error) {
      if (!(error instanceof AssetNotFoundError)) {
        throw new ToolFatalError(ErrorCode.ASSET_REPOSITORY_UNAVAILABLE, `Base asset repository unavailable: ${(error as Error).message}`, { cause: error });
      }
      throw new ToolFatalError(ErrorCode.ASSET_NOT_FOUND, `Base asset cannot be read: ${(error as Error).message}`, { cause: error });
    }
    if (!asset?.uri) {
      throw new ToolFatalError(ErrorCode.INVALID_ASSET_URI, `Base asset has no uri: ${asset?.id}`);
    }
    try {
      const key = resolveAssetStorageKey(asset.uri, assetStorage.bucket);
      return { ...asset, storageKey: key };
    } catch (error) {
      if (error instanceof InvalidAssetUriError) {
        throw new ToolFatalError(ErrorCode.INVALID_ASSET_URI, error.message, { cause: error });
      }
      throw error;
    }
  }

  async function fetchBaseBytes(base: { storageKey: string }) {
    try {
      return await assetStorage.get(base.storageKey);
    } catch (error) {
      throw new ToolFatalError(ErrorCode.ASSET_STORAGE_UNAVAILABLE, `Base image bytes cannot be fetched: ${(error as Error).message}`, { cause: error });
    }
  }

  async function putGeneratedImage(key: string, bytes: Buffer, contentType: string) {
    try {
      await assetStorage.put(key, bytes, contentType);
    } catch (error) {
      throw new ToolFatalError(ErrorCode.ASSET_STORAGE_UNAVAILABLE, `Generated image cannot be stored: ${(error as Error).message}`, { cause: error });
    }
  }

  return {
    name: "generate_image",
    description: "Generate image candidates from the current state and a state patch",
    label: "Generate image candidate",
    parameters: {
      type: "object" as const,
      properties: {
        patch: {
          type: "object" as const,
          description: "Structured target state changes. modify is the list of paths to change; preserve lists constraints that must not change.",
          properties: {
            modify: {
              type: "array" as const,
              description: "List of state modifications",
              items: {
                type: "object" as const,
                properties: {
                  path: {
                    type: "string" as const,
                    description: "Photo state path to modify",
                    enum: [
                      "subject.identity.preserve", "subject.hair.preserve",
                      "subject.expression", "subject.pose", "scene.location", "scene.time",
                      "scene.mood", "scene.background", "scene.lighting", "appearance.outfit",
                      "appearance.makeup", "composition.shot", "composition.cameraAngle",
                    ],
                  },
                  operation: { type: "string" as const, enum: ["replace"] },
                  value: { description: "New value for this path" },
                },
                required: ["path", "operation", "value"],
              },
            },
            preserve: {
              type: "array" as const,
              description: "Constraints that must remain unchanged. hard means strict.",
              items: {
                type: "object" as const,
                properties: {
                  path: {
                    type: "string" as const,
                    enum: [
                      "subject.identity", "subject.hair", "subject.expression", "subject.pose",
                      "scene.background", "scene.location", "scene.lighting", "appearance.outfit",
                      "appearance.makeup", "composition", "composition.shot", "composition.cameraAngle",
                    ],
                  },
                  strength: { type: "string" as const, enum: ["soft", "hard"] },
                },
                required: ["path"],
              },
            },
          },
          required: ["modify"],
        },
        renderPrompt: { type: "string" as const, description: "Visual details that cannot be expressed structurally (lighting, mood, texture)" },
      },
      required: ["patch", "renderPrompt"],
    },
    async execute(_toolCallId: string, rawParams: unknown, signal?: AbortSignal) {
      const params = rawParams as GenerateImageParams;
      if (turnContext.imageCount >= config.guards.maxImagesPerTurn) {
        throw new MaxImagesReachedError(config.guards.maxImagesPerTurn);
      }
      if (turnContext.imageAttempts >= config.guards.maxImageAttemptsPerTurn) {
        throw new MaxImageAttemptsReachedError(config.guards.maxImageAttemptsPerTurn);
      }

      const revision = await repository.getRevision(turnContext.activeRevisionId);
      const proposedState = applyPhotoStatePatch(revision.state, params.patch as unknown as StatePatch);
      turnContext.noteAttempt();

      try {
        const base = turnContext.currentBaseAssetId ? await readBaseImage() : null;
        const stored = base ? await fetchBaseBytes(base) : null;
        const generated = await telemetry.startSpan(
          {
            name: "pi.ai.generate_images",
            attributes: {
              "pi.turn.id": turnContext.turnId,
              "pi.project.id": turnContext.projectId,
              "pi.model.id": imageProvider.modelId,
            },
          },
          () => imageProvider.generate({
            prompt: params.renderPrompt,
            baseImage: stored
              ? { data: stored.bytes.toString("base64"), mimeType: stored.contentType ?? "image/png" }
              : null,
            signal,
          }),
        );
        if (!generated.ok) {
          const { failure } = generated;
          if (failure.fatal) {
            turnContext.setFatal(failure.code, new Error(failure.message));
            return {
              content: [{ type: "text" as const, text: `Fatal image generation failure: ${failure.message}` }],
              details: { fatalCode: failure.code },
              terminate: true,
            };
          }
          throw new Error(failure.message);
        }

        const image = generated.image;
        const contentType: string = image.mimeType ?? "image/png";
        const extension = EXTENSION_BY_MIME.get(contentType);
        if (!extension) throw new Error(`Unsupported generated image content type: ${contentType}`);
        const imageCount = turnContext.noteImage();
        const bytes = Buffer.from(image.data, "base64");
        const assetId = `candidate_${turnContext.turnId}_${imageCount}`;
        const key = buildAssetKey({
          ownerId: turnContext.ownerId,
          projectId: turnContext.projectId,
          assetId,
          contentType,
        });
        await putGeneratedImage(key, bytes, contentType);
        const generation = await repository.recordGeneration({
          projectId: turnContext.projectId,
          turnId: turnContext.turnId,
          baseRevisionId: revision.id,
          inputAssetId: turnContext.currentBaseAssetId,
          patch: params.patch,
          renderPrompt: params.renderPrompt,
          outcome: {
            kind: "completed",
            candidate: {
              candidateId: assetId,
              assetId,
              uri: buildAssetUri(assetStorage.bucket, key),
              metadata: { contentType, model: imageProvider.modelId },
              verification: {},
            },
          },
        });
        const candidate = generation.candidates?.[0] ?? { id: generation.selectedCandidateId };
        const candidateId = candidate.id ?? generation.selectedCandidateId;
        turnContext.advanceBase(candidateId ?? assetId);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ generationId: generation.id, candidateId, assetId }),
            },
            { type: "image" as const, data: image.data, mimeType: contentType },
          ],
          details: { generationId: generation.id, candidateId, assetId },
        };
      } catch (error) {
        const fatal = error instanceof ToolFatalError ? error : null;
        if (fatal) {
          turnContext.setFatal(fatal.fatalCode, fatal.cause ?? fatal);
          return {
            content: [{ type: "text" as const, text: `Fatal image generation failure: ${fatal.message}` }],
            details: { fatalCode: fatal.fatalCode },
            terminate: true,
          };
        }
        throw error;
      }
    },
  };
}
