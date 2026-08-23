import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadApiConfig, loadImageConfig, loadWorkerConfig } from '../src/config.mjs';

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
  assert.equal(config.turnLeaseMs, 30000);
  assert.equal(config.heartbeatMs, 10000);
  assert.equal(config.workerConcurrency, 4);
  assert.equal(config.shutdownGraceMs, 600000);
  assert.equal(config.pollIntervalMs, 500);
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

test('image size defaults to an explicit value and never auto', () => {
  const config = loadWorkerConfig(FULL_WORKER_ENV);
  assert.equal(config.image.size, '1024x1024');
  assert.notEqual(config.image.size, 'auto', 'auto makes the relay time out with 502');
});

test('image edit route defaults to chat and rejects unknown values', () => {
  assert.equal(loadWorkerConfig(FULL_WORKER_ENV).image.editRoute, 'chat');
  assert.equal(
    loadWorkerConfig({ ...FULL_WORKER_ENV, IMAGE_EDIT_ROUTE: 'edits' }).image.editRoute,
    'edits',
  );
  assert.throws(
    () => loadWorkerConfig({ ...FULL_WORKER_ENV, IMAGE_EDIT_ROUTE: 'magic' }),
    /IMAGE_EDIT_ROUTE/,
  );
});

test('image-only config does not require llm credentials', () => {
  const config = loadImageConfig({
    IMAGE_BASE_URL: 'https://relay.example.com/v1',
    IMAGE_API_KEY: 'image-key',
    S3_ACCESS_KEY: 'ak',
    S3_SECRET_KEY: 'sk',
  });
  assert.equal(config.image.modelId, 'gpt-image-2');
  assert.equal(config.image.size, '1024x1024');
  assert.ok(!('llm' in config), 'the image smoke never calls the LLM');
});

test('image-only config still requires the relay credentials it does use', () => {
  assert.throws(
    () => loadImageConfig({ S3_ACCESS_KEY: 'ak', S3_SECRET_KEY: 'sk' }),
    /IMAGE_BASE_URL/,
  );
});

test('numeric guards reject non-numeric values instead of silently using NaN', () => {
  assert.throws(
    () => loadWorkerConfig({ ...FULL_WORKER_ENV, MAX_IMAGES_PER_TURN: 'many' }),
    /MAX_IMAGES_PER_TURN/,
  );
});

test('image attempt cap defaults to twice the image quota and can be overridden', () => {
  const defaults = loadWorkerConfig({ LLM_API_KEY: 'k', IMAGE_BASE_URL: 'https://i', IMAGE_API_KEY: 'k', S3_ACCESS_KEY: 'k', S3_SECRET_KEY: 'k' });
  assert.equal(defaults.guards.maxImagesPerTurn, 3);
  assert.equal(defaults.guards.maxImageAttemptsPerTurn, 6);

  const overridden = loadWorkerConfig({ LLM_API_KEY: 'k', IMAGE_BASE_URL: 'https://i', IMAGE_API_KEY: 'k', S3_ACCESS_KEY: 'k', S3_SECRET_KEY: 'k', MAX_IMAGES_PER_TURN: '2', MAX_IMAGE_ATTEMPTS_PER_TURN: '3' });
  assert.equal(overridden.guards.maxImagesPerTurn, 2);
  assert.equal(overridden.guards.maxImageAttemptsPerTurn, 3);
});
