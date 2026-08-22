import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadApiConfig, loadWorkerConfig } from '../src/config.mjs';

const FULL_WORKER_ENV = {
  LLM_API_KEY: 'llm-key',
  IMAGE_BASE_URL: 'https://relay.example.com',
  IMAGE_API_KEY: 'image-key',
  S3_ACCESS_KEY: 'ak',
  S3_SECRET_KEY: 'sk',
};

test('worker config applies documented defaults', () => {
  const config = loadWorkerConfig(FULL_WORKER_ENV);
  assert.equal(config.llm.baseUrl, 'https://api.deepseek.com');
  assert.equal(config.llm.modelId, 'deepseek-v4-flash-vision-exp');
  assert.equal(config.image.modelId, 'gpt-image-2');
  assert.equal(config.guards.maxImagesPerTurn, 3);
  assert.equal(config.guards.imageTimeoutMs, 180000);
  assert.equal(config.telemetry, 'stdout');
});

test('worker config fails fast on every missing credential', () => {
  for (const missing of Object.keys(FULL_WORKER_ENV)) {
    const env = { ...FULL_WORKER_ENV };
    delete env[missing];
    assert.throws(
      () => loadWorkerConfig(env),
      new RegExp(missing),
      `${missing} must be required`,
    );
  }
});

test('api config does not require model credentials', () => {
  const config = loadApiConfig({ S3_ACCESS_KEY: 'ak', S3_SECRET_KEY: 'sk' });
  assert.equal(config.port, 3000);
  assert.equal(config.s3.accessKey, 'ak');
  assert.ok(
    !('llm' in config),
    'API does not load the agent, so it needs no LLM credentials',
  );
});

test('api config still requires object storage credentials for signed urls', () => {
  assert.throws(() => loadApiConfig({ S3_ACCESS_KEY: 'ak' }), /S3_SECRET_KEY/);
});

test('numeric guards reject non-numeric values instead of silently using NaN', () => {
  assert.throws(
    () => loadWorkerConfig({ ...FULL_WORKER_ENV, MAX_IMAGES_PER_TURN: 'many' }),
    /MAX_IMAGES_PER_TURN/,
  );
});
