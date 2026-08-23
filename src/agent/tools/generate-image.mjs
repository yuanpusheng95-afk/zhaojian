import { AssetNotFoundError } from '../../domain/photo-project-service.mjs';
import { applyPhotoStatePatch } from '../../domain/photo-state.mjs';
import { createNoopTelemetry } from '../../infrastructure/telemetry/stdout-telemetry.mjs';
import {
  InvalidAssetUriError,
  buildAssetKey,
  buildAssetUri,
  resolveAssetStorageKey,
} from '../../infrastructure/storage/asset-storage.mjs';
import { MaxImageAttemptsReachedError, MaxImagesReachedError } from './turn-context.mjs';

const EXTENSION_BY_MIME = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
]);

function isFatalProviderError(error) {
  const message = String(error?.message ?? error).toLowerCase();
  return message.includes('http 401')
    || message.includes('unauthorized')
    || message.includes('quota')
    || message.includes('insufficient');
}

export function createGenerateImageTool({
  repository,
  imagesModels,
  assetStorage,
  turnContext,
  config,
  telemetry = createNoopTelemetry(),
}) {
  async function readBaseImage() {
    let asset;
    try {
      asset = await repository.getAsset(turnContext.currentBaseAssetId);
    } catch (error) {
      if (!(error instanceof AssetNotFoundError)) {
        throw Object.assign(new Error(`Base asset repository unavailable: ${error.message}`), {
          fatalCode: 'ASSET_REPOSITORY_UNAVAILABLE',
          cause: error,
        });
      }
      throw Object.assign(new Error(`Base asset cannot be read: ${error.message}`), {
        fatalCode: 'ASSET_NOT_FOUND',
        cause: error,
      });
    }
    if (!asset?.uri) {
      throw Object.assign(new Error(`Base asset has no uri: ${asset?.id}`), {
        fatalCode: 'INVALID_ASSET_URI',
      });
    }
    try {
      const key = resolveAssetStorageKey(asset.uri, assetStorage.bucket);
      return { ...asset, storageKey: key };
    } catch (error) {
      if (error instanceof InvalidAssetUriError) {
        throw Object.assign(new Error(error.message), { fatalCode: 'INVALID_ASSET_URI', cause: error });
      }
      throw error;
    }
  }

  async function fetchBaseBytes(base) {
    try {
      return await assetStorage.get(base.storageKey);
    } catch (error) {
      throw Object.assign(new Error(`Base image bytes cannot be fetched: ${error.message}`), {
        fatalCode: 'ASSET_STORAGE_UNAVAILABLE',
        cause: error,
      });
    }
  }

  async function putGeneratedImage(key, bytes, contentType) {
    try {
      await assetStorage.put(key, bytes, contentType);
    } catch (error) {
      throw Object.assign(new Error(`Generated image cannot be stored: ${error.message}`), {
        fatalCode: 'ASSET_STORAGE_UNAVAILABLE',
        cause: error,
      });
    }
  }

  return {
    name: 'generate_image',
    label: 'Generate image candidate',
    parameters: {
      type: 'object',
      properties: {
        patch: {
          type: 'object',
          description: '结构化的目标状态变更。modify 是要改的路径,preserve 是必须保持不变的约束(如人物身份)',
          properties: {
            modify: {
              type: 'array',
              description: '要修改的状态指令列表',
              items: {
                type: 'object',
                properties: {
                  path: {
                    type: 'string',
                    description: '要修改的 Photo State 路径',
                    enum: [
                      'subject.identity.preserve', 'subject.hair.preserve',
                      'subject.expression', 'subject.pose', 'scene.location', 'scene.time',
                      'scene.mood', 'scene.background', 'scene.lighting', 'appearance.outfit',
                      'appearance.makeup', 'composition.shot', 'composition.cameraAngle',
                    ],
                  },
                  operation: { type: 'string', enum: ['replace'] },
                  value: { description: '该路径的新值' },
                },
                required: ['path', 'operation', 'value'],
              },
            },
            preserve: {
              type: 'array',
              description: '必须保持不变的内容,hard 表示硬约束',
              items: {
                type: 'object',
                properties: {
                  path: {
                    type: 'string',
                    description: '要保持的状态路径',
                    enum: [
                      'subject.identity', 'subject.hair', 'subject.expression', 'subject.pose',
                      'scene.background', 'scene.location', 'scene.lighting', 'appearance.outfit',
                      'appearance.makeup', 'composition', 'composition.shot', 'composition.cameraAngle',
                    ],
                  },
                  strength: { type: 'string', enum: ['soft', 'hard'] },
                },
                required: ['path'],
              },
            },
          },
          required: ['modify'],
        },
        renderPrompt: { type: 'string', description: '无法结构化的渲染细节(光线、氛围、质感),不要把状态变更写在这里' },
      },
      required: ['patch', 'renderPrompt'],
    },
    async execute(toolCallId, params, signal) {
      if (turnContext.imageCount >= config.guards.maxImagesPerTurn) {
        throw new MaxImagesReachedError(config.guards.maxImagesPerTurn);
      }
      if (turnContext.imageAttempts >= config.guards.maxImageAttemptsPerTurn) {
        throw new MaxImageAttemptsReachedError(config.guards.maxImageAttemptsPerTurn);
      }

      // 校验先于一切 IO：非法 patch 在花钱和碰存储之前就该被模型自纠。
      // params.patch 已是 domain 形状 {modify, preserve}——schema 与 domain 契约一致(§5.3)
      const revision = await repository.getRevision(turnContext.activeRevisionId);
      const proposedState = applyPhotoStatePatch(revision.state, params.patch);
      // 尝试计数在 patch 校验之后:非法 patch 是模型自纠的免费错误,不烧尝试额度
      turnContext.noteAttempt();

      try {
        const base = await readBaseImage();
        const stored = await fetchBaseBytes(base);
        // 生图单独一个 span:把 pi.agent.tool 的总时长拆出"供应商生图"这一层(§11.3)
        const generated = await telemetry.startSpan(
          {
            name: 'pi.ai.generate_images',
            attributes: {
              'pi.turn.id': turnContext.turnId,
              'pi.project.id': turnContext.projectId,
              'pi.model.id': config.image.modelId,
            },
          },
          () => imagesModels.generateImages(
            imagesModels.model,
            {
              input: [
                { type: 'text', text: params.renderPrompt },
                { type: 'image', data: stored.bytes.toString('base64'), mimeType: stored.contentType ?? 'image/png' },
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
        if (generated.stopReason === 'error' || !generated.output?.length) {
          const message = generated.errorMessage ?? 'Image provider returned no image';
          if (isFatalProviderError({ message })) {
            throw Object.assign(new Error(message), { fatalCode: message.includes('401') || message.toLowerCase().includes('unauthorized') ? 'IMAGE_PROVIDER_UNAUTHORIZED' : 'IMAGE_PROVIDER_UNAVAILABLE' });
          }
          throw new Error(message);
        }

        const image = generated.output[0];
        const contentType = image.mimeType ?? 'image/png';
        const extension = EXTENSION_BY_MIME.get(contentType);
        if (!extension) throw new Error(`Unsupported generated image content type: ${contentType}`);
        // 只统计真正产出的图像：provider 失败、abort 或 MIME 不支持不消耗配额。
        const imageCount = turnContext.noteImage();
        const bytes = Buffer.from(image.data, 'base64');
        // turnId 必须进 assetId：imageCount 每轮从 1 重新计数，
        // 不掺 turnId 会让第二轮的 candidate_1 经 upsert 覆盖第一轮的 asset 行与存储对象
        const assetId = `candidate_${turnContext.turnId}_${imageCount}`;
        const key = buildAssetKey({
          ownerId: 'dev',
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
            kind: 'completed',
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
          // ID 必须进 content:details 只被 pi 持久化、不发给模型,
          // 模型看不到 generationId/candidateId 就无法调 select_candidate(实测踩过)
          content: [
            {
              type: 'text',
              text: JSON.stringify({ generationId: generation.id, candidateId, assetId }),
            },
            { type: 'image', data: image.data, mimeType: contentType },
          ],
          details: { generationId: generation.id, candidateId, assetId },
        };
      } catch (error) {
        if (error.fatalCode) {
          turnContext.setFatal(error.fatalCode, error.cause ?? error);
          return {
            content: [{ type: 'text', text: `Fatal image generation failure: ${error.message}` }],
            details: { fatalCode: error.fatalCode },
            terminate: true,
          };
        }
        throw error;
      }
    },
  };
}
