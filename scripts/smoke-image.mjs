// 真实生图冒烟。手动执行，会产生费用，不进 CI。
//
// 人类可读日志走 stderr，stdout 只留 telemetry 的 JSON 行（设计文档 §12.3），
// 因此 `npm run smoke:image ... 2>/dev/null | jq` 可以直接解析。
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { loadImageConfig } from '../src/config.mjs';
import { createRelayImagesModels } from '../src/infrastructure/models/relay-images-provider.mjs';
import { buildAssetKey } from '../src/infrastructure/storage/asset-storage.mjs';
import { createS3AssetStorage } from '../src/infrastructure/storage/s3-asset-storage.mjs';
import { createStdoutTelemetry } from '../src/infrastructure/telemetry/stdout-telemetry.mjs';

const log = (message) => process.stderr.write(`${message}\n`);

const config = loadImageConfig();
const [inputPath, ...promptParts] = process.argv.slice(2);
if (!inputPath) {
  log('Usage: npm run smoke:image -- <image-path> [prompt...]');
  process.exit(1);
}
const prompt = promptParts.join(' ') || '把背景换成海边沙滩，保持人物面部特征不变';

const telemetry = createStdoutTelemetry();
const storage = createS3AssetStorage(config.s3);
const imagesModels = createRelayImagesModels({
  baseUrl: config.image.baseUrl,
  modelId: config.image.modelId,
});

const baseBytes = await readFile(inputPath);
log(`base image : ${inputPath} (${baseBytes.length} bytes)`);
log(`prompt     : ${prompt}`);
log(`model      : ${config.image.modelId} @ ${config.image.baseUrl}`);
log(`route      : ${config.image.editRoute}  size: ${config.image.size}`);

const model = imagesModels.getModel('relay', config.image.modelId);
if (!model) throw new Error(`Model not registered: ${config.image.modelId}`);

const result = await telemetry.startSpan(
  {
    name: 'pi.ai.request',
    attributes: {
      'pi.ai.operation': 'generate_images',
      'pi.ai.model': config.image.modelId,
    },
  },
  (span) =>
    imagesModels
      .generateImages(
        model,
        {
          input: [
            { type: 'text', text: prompt },
            {
              type: 'image',
              data: baseBytes.toString('base64'),
              mimeType: 'image/png',
            },
          ],
        },
        {
          timeoutMs: config.guards.imageTimeoutMs,
          size: config.image.size,
          editRoute: config.image.editRoute,
        },
      )
      .then((value) => {
        span.setAttributes({ 'pi.ai.stop_reason': value.stopReason });
        if (value.stopReason !== 'stop') {
          span.setStatus({
            status: 'error',
            error: { name: 'ImageGenerationFailed', message: value.errorMessage ?? '' },
          });
        }
        return value;
      }),
);

log(`stopReason : ${result.stopReason}`);

if (result.stopReason !== 'stop') {
  log(`FAILED: ${result.errorMessage}`);
  process.exit(1);
}

const image = result.output.find((item) => item.type === 'image');
if (!image) {
  log('FAILED: response contained no image');
  process.exit(1);
}

const assetId = randomUUID();
const key = buildAssetKey({
  ownerId: 'dev',
  projectId: 'smoke',
  assetId,
  contentType: image.mimeType,
});
const bytes = Buffer.from(image.data, 'base64');
await storage.put(key, bytes, image.mimeType);
const url = await storage.getSignedUrl(key, { expiresInSeconds: 3600 });

log('');
log(`generated  : ${bytes.length} bytes, ${image.mimeType}`);
log(`stored     : ${key}`);
log(`signed url : ${url}`);
log('MinIO console: http://127.0.0.1:9001  (photoagent / photoagent123)');
