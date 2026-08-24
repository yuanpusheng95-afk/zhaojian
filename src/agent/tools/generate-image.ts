import { AssetNotFoundError } from "../../domain/photo-project-service.js";
import { applyPhotoStatePatch } from "../../domain/photo-state.js";
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

const EXTENSION_BY_MIME = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
]);

function isFatalProviderError(error: { message?: string }): boolean {
  const message = String(error?.message ?? error).toLowerCase();
  return message.includes("http 401")
    || message.includes("unauthorized")
    || message.includes("quota")
    || message.includes("insufficient");
}

export function createGenerateImageTool({
  repository, imagesModels, assetStorage, turnContext, config, telemetry = createNoopTelemetry(),
}: {
  repository: any;
  imagesModels: any;
  assetStorage: any;
  turnContext: TurnContext;
  config: any;
  telemetry?: TelemetryContext;
}) {
  async function readBaseImage() {
    let asset: any;
    try {
      asset = await repository.getAsset(turnContext.currentBaseAssetId!);
    } catch (error) {
      if (!(error instanceof AssetNotFoundError)) {
        throw Object.assign(new Error(`Base asset repository unavailable: ${(error as Error).message}`), {
          fatalCode: "ASSET_REPOSITORY_UNAVAILABLE",
          cause: error,
        });
      }
      throw Object.assign(new Error(`Base asset cannot be read: ${(error as Error).message}`), {
        fatalCode: "ASSET_NOT_FOUND",
        cause: error,
      });
    }
    if (!asset?.uri) {
      throw Object.assign(new Error(`Base asset has no uri: ${asset?.id}`), {
        fatalCode: "INVALID_ASSET_URI",
      });
    }
    try {
      const key = resolveAssetStorageKey(asset.uri, assetStorage.bucket);
      return { ...asset, storageKey: key };
    } catch (error) {
      if (error instanceof InvalidAssetUriError) {
        throw Object.assign(new Error(error.message), { fatalCode: "INVALID_ASSET_URI", cause: error });
      }
      throw error;
    }
  }

  async function fetchBaseBytes(base: { storageKey: string }) {
    try {
      return await assetStorage.get(base.storageKey);
    } catch (error) {
      throw Object.assign(new Error(`Base image bytes cannot be fetched: ${(error as Error).message}`), {
        fatalCode: "ASSET_STORAGE_UNAVAILABLE",
        cause: error,
      });
    }
  }

  async function putGeneratedImage(key: string, bytes: Buffer, contentType: string) {
    try {
      await assetStorage.put(key, bytes, contentType);
    } catch (error) {
      throw Object.assign(new Error(`Generated image cannot be stored: ${(error as Error).message}`), {
        fatalCode: "ASSET_STORAGE_UNAVAILABLE",
        cause: error,
      });
    }
  }

  return {
    name: "generate_image",
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
    async execute(_toolCallId: string, params: any, signal?: AbortSignal) {
      if (turnContext.imageCount >= config.guards.maxImagesPerTurn) {
        throw new MaxImagesReachedError(config.guards.maxImagesPerTurn);
      }
      if (turnContext.imageAttempts >= config.guards.maxImageAttemptsPerTurn) {
        throw new MaxImageAttemptsReachedError(config.guards.maxImageAttemptsPerTurn);
      }

      const revision = await repository.getRevision(turnContext.activeRevisionId);
      const proposedState = applyPhotoStatePatch(revision.state as any, params.patch);
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
              "pi.model.id": config.image.modelId,
            },
          },
          () => imagesModels.generateImages(
            imagesModels.model,
            {
              input: [
                { type: "text", text: params.renderPrompt },
                ...(stored ? [{
                  type: "image",
                  data: stored.bytes.toString("base64"),
                  mimeType: stored.contentType ?? "image/png",
                }] : []),
              ],
            },
            {
              apiKey: config.image.apiKey,
              size: config.image.size,
              editRoute: config.image.editRoute,
              signal,
            },
          ),
        );
        if (generated.stopReason === "error" || !generated.output?.length) {
          const message = generated.errorMessage ?? "Image provider returned no image";
          if (isFatalProviderError({ message })) {
            throw Object.assign(new Error(message), {
              fatalCode: message.includes("401") || message.toLowerCase().includes("unauthorized")
                ? "IMAGE_PROVIDER_UNAUTHORIZED"
                : "IMAGE_PROVIDER_UNAVAILABLE",
            });
          }
          throw new Error(message);
        }

        const image = generated.output[0];
        const contentType: string = image.mimeType ?? "image/png";
        const extension = EXTENSION_BY_MIME.get(contentType);
        if (!extension) throw new Error(`Unsupported generated image content type: ${contentType}`);
        const imageCount = turnContext.noteImage();
        const bytes = Buffer.from(image.data, "base64");
        const assetId = `candidate_${turnContext.turnId}_${imageCount}`;
        const key = buildAssetKey({
          ownerId: "dev",
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
              metadata: { contentType, model: config.image.modelId },
              verification: {},
            },
          },
        });
        const candidate = generation.candidates?.[0] ?? { id: generation.candidateId };
        turnContext.advanceBase(candidate.id ?? generation.candidateId);
        const candidateId = candidate.id ?? generation.candidateId;
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
      } catch (error: any) {
        if (error.fatalCode) {
          turnContext.setFatal(error.fatalCode, error.cause ?? error);
          return {
            content: [{ type: "text" as const, text: `Fatal image generation failure: ${error.message}` }],
            details: { fatalCode: error.fatalCode },
            terminate: true,
          };
        }
        throw error;
      }
    },
  };
}
