import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createGenerateImageTool,
  createReadPhotoStateTool,
  createSelectCandidateTool,
  createTurnContext,
} from '../src/agent/tools/index.mjs';
import { AssetNotFoundError } from '../src/domain/photo-project-service.mjs';

const revision = {
  id: 'revision_1',
  projectId: 'project_1',
  state: { appearance: { outfit: 'black jacket' }, constraints: [] },
  anchorAssetId: 'asset_base',
};

function createRepository() {
  const assets = new Map([[
    'asset_base',
    {
      id: 'asset_base',
      kind: 'source',
      uri: 's3://photo-agent/base.png',
      metadata: { contentType: 'image/png' },
    },
  ]]);
  return {
    assets,
    generations: [],
    revisions: [revision],
    selected: null,
    activeRevisionId: revision.id,
    async getRevision() { return revision; },
    async getAsset(assetId) {
      const asset = assets.get(assetId);
      if (!asset) throw new AssetNotFoundError(assetId);
      return asset;
    },
    async recordGeneration(input) {
      const candidate = input.outcome.candidate;
      assets.set(candidate.assetId, {
        id: candidate.assetId,
        kind: 'generated',
        uri: candidate.uri,
        metadata: candidate.metadata,
      });
      const generation = {
        id: `generation_${this.generations.length + 1}`,
        candidateId: input.outcome.candidate.candidateId ?? `candidate_${this.generations.length + 1}`,
        ...input,
      };
      this.generations.push(generation);
      return generation;
    },
    async selectCandidate({ generationId, candidateId }) {
      if (candidateId === 'candidate_bad') throw new Error('bad candidate');
      this.selected = { generationId, candidateId };
      return { id: 'revision_2' };
    },
  };
}

function createModels({ fail = false } = {}) {
  const calls = [];
  const model = { provider: 'relay', id: 'image-model', api: 'relay-openai-images' };
  return {
    calls,
    model,
    async generateImages(actualModel, context) {
      calls.push({ actualModel, context });
      if (fail === 'transient') {
        return { output: [], stopReason: 'error', errorMessage: 'HTTP 503 service unavailable' };
      }
      if (fail) {
        return { output: [], stopReason: 'error', errorMessage: 'HTTP 401 Unauthorized' };
      }
      return {
        output: [{ type: 'image', data: 'ZmFrZQ==', mimeType: 'image/png' }],
        stopReason: 'stop',
      };
    },
  };
}

function createStorage({ getError } = {}) {
  const puts = [];
  const gets = [];
  return {
    bucket: 'photo-agent',
    puts,
    gets,
    async get(key) {
      gets.push(key);
      if (getError) throw getError;
      return { bytes: Buffer.from('base'), contentType: 'image/png' };
    },
    async put(key, bytes, contentType) {
      puts.push({ key, bytes, contentType });
    },
  };
}

const config = { guards: { maxImagesPerTurn: 2 }, image: { size: '1024x1024', modelId: 'gpt-image-2' } };
const patch = { modify: [{ path: 'appearance.outfit', operation: 'replace', value: 'ivory coat' }], preserve: [] };

test('read_photo_state returns the current pointer and origin marker', async () => {
  const repository = createRepository();
  const turnContext = createTurnContext({ projectId: 'project_1', turnId: 'turn_1', initialBaseAssetId: 'asset_base', activeRevisionId: 'revision_1' });
  const tool = createReadPhotoStateTool({ repository, turnContext });

  const result = await tool.execute('call_1', {});
  assert.deepEqual(result.content[0], { type: 'text', text: JSON.stringify({
    revisionId: 'revision_1',
    state: revision.state,
    baseImage: { assetId: 'asset_base', origin: 'revision_anchor' },
  }) });
});

test('generate_image validates, generates, persists, stores, and advances the pointer', async () => {
  const repository = createRepository();
  const imagesModels = createModels();
  const assetStorage = createStorage();
  const turnContext = createTurnContext({ projectId: 'project_1', turnId: 'turn_1', initialBaseAssetId: 'asset_base', activeRevisionId: 'revision_1' });
  const tool = createGenerateImageTool({ repository, imagesModels, assetStorage, turnContext, config });

  const result = await tool.execute('call_1', { patch, renderPrompt: 'ivory coat' });
  assert.equal(result.terminate, undefined);
  assert.equal(result.content.some(({ type }) => type === 'image'), true);
  assert.deepEqual(assetStorage.gets, ['base.png']);
  assert.equal(repository.generations.length, 1);
  assert.equal(turnContext.currentBaseAssetId, 'candidate_turn_1_1');
  assert.equal(assetStorage.puts[0].contentType, 'image/png');
});

test('generate_image rejects an invalid patch before spending money', async () => {
  const repository = createRepository();
  const imagesModels = createModels();
  const assetStorage = createStorage();
  const turnContext = createTurnContext({ projectId: 'project_1', turnId: 'turn_1', initialBaseAssetId: 'asset_base', activeRevisionId: 'revision_1' });
  const tool = createGenerateImageTool({ repository, imagesModels, assetStorage, turnContext, config });

  await assert.rejects(
    tool.execute('call_1', { patch: { modify: [{ path: 'not.allowed', operation: 'replace', value: 1 }] }, renderPrompt: 'x' }),
  );
  assert.equal(imagesModels.calls.length, 0);
  assert.equal(repository.generations.length, 0);
});

test('generate_image enforces the per-turn image limit as a recoverable error', async () => {
  const repository = createRepository();
  const imagesModels = createModels();
  const assetStorage = createStorage();
  const turnContext = createTurnContext({ projectId: 'project_1', turnId: 'turn_1', initialBaseAssetId: 'asset_base', activeRevisionId: 'revision_1' });
  const tool = createGenerateImageTool({ repository, imagesModels, assetStorage, turnContext, config });

  await tool.execute('call_1', { patch, renderPrompt: 'one' });
  await tool.execute('call_2', { patch, renderPrompt: 'two' });
  await assert.rejects(
    tool.execute('call_3', { patch, renderPrompt: 'three' }),
    (error) => error.code === 'MAX_IMAGES_REACHED',
  );
});

test('generate_image marks provider auth failure as fatal and terminates', async () => {
  const repository = createRepository();
  const imagesModels = createModels({ fail: true });
  const assetStorage = createStorage();
  const turnContext = createTurnContext({ projectId: 'project_1', turnId: 'turn_1', initialBaseAssetId: 'asset_base', activeRevisionId: 'revision_1' });
  const tool = createGenerateImageTool({ repository, imagesModels, assetStorage, turnContext, config });

  const result = await tool.execute('call_1', { patch, renderPrompt: 'fail' });
  assert.equal(result.terminate, true);
  assert.equal(turnContext.fatal.code, 'IMAGE_PROVIDER_UNAUTHORIZED');
});

test('generate_image does not consume the image quota when the provider fails', async () => {
  const repository = createRepository();
  const imagesModels = createModels({ fail: true });
  const turnContext = createTurnContext({ projectId: 'project_1', turnId: 'turn_1', initialBaseAssetId: 'asset_base', activeRevisionId: 'revision_1' });
  const tool = createGenerateImageTool({ repository, imagesModels, assetStorage: createStorage(), turnContext, config });

  await tool.execute('call_1', { patch, renderPrompt: 'fail' });

  assert.equal(turnContext.imageCount, 0);
});

test('generate_image distinguishes a missing base asset from a repository failure', async () => {
  const repository = createRepository();
  repository.getAsset = async () => {
    throw new Error('connection refused');
  };
  const turnContext = createTurnContext({ projectId: 'project_1', turnId: 'turn_1', initialBaseAssetId: 'asset_base', activeRevisionId: 'revision_1' });
  const tool = createGenerateImageTool({ repository, imagesModels: createModels(), assetStorage: createStorage(), turnContext, config });

  const result = await tool.execute('call_1', { patch, renderPrompt: 'ivory coat' });

  assert.equal(result.details.fatalCode, 'ASSET_REPOSITORY_UNAVAILABLE');
  assert.equal(result.terminate, true);
});

test('generate_image uses the previous candidate as the next base image', async () => {
  const repository = createRepository();
  const imagesModels = createModels();
  const assetStorage = createStorage();
  const turnContext = createTurnContext({ projectId: 'project_1', turnId: 'turn_1', initialBaseAssetId: 'asset_base', activeRevisionId: 'revision_1' });
  const tool = createGenerateImageTool({ repository, imagesModels, assetStorage, turnContext, config });

  await tool.execute('call_1', { patch, renderPrompt: 'first' });
  await tool.execute('call_2', { patch, renderPrompt: 'second' });
  assert.deepEqual(assetStorage.gets, ['base.png', 'users/dev/projects/project_1/candidate_turn_1_1.png']);
});

test('generate_image treats invalid asset uris as fatal', async () => {
  const repository = createRepository();
  repository.assets.get('asset_base').uri = 'not-a-uri';
  const imagesModels = createModels();
  const assetStorage = createStorage();
  const turnContext = createTurnContext({ projectId: 'project_1', turnId: 'turn_1', initialBaseAssetId: 'asset_base', activeRevisionId: 'revision_1' });
  const tool = createGenerateImageTool({ repository, imagesModels, assetStorage, turnContext, config });

  const result = await tool.execute('call_1', { patch, renderPrompt: 'invalid uri' });
  assert.equal(result.terminate, true);
  assert.equal(result.details.fatalCode, 'INVALID_ASSET_URI');
  assert.equal(turnContext.fatal.code, 'INVALID_ASSET_URI');
  assert.equal(imagesModels.calls.length, 0);
});

test('select_candidate selects the candidate and terminates the turn', async () => {
  const repository = createRepository();
  const turnContext = createTurnContext({ projectId: 'project_1', turnId: 'turn_1', initialBaseAssetId: 'asset_base', activeRevisionId: 'revision_1' });
  const tool = createSelectCandidateTool({ repository, turnContext });

  const result = await tool.execute('call_1', { generationId: 'generation_1', candidateId: 'candidate_1' });
  assert.equal(result.terminate, true);
  assert.deepEqual(repository.selected, { generationId: 'generation_1', candidateId: 'candidate_1' });
});

test('select_candidate lets a bad candidate remain recoverable', async () => {
  const repository = createRepository();
  const turnContext = createTurnContext({ projectId: 'project_1', turnId: 'turn_1', initialBaseAssetId: 'asset_base', activeRevisionId: 'revision_1' });
  const tool = createSelectCandidateTool({ repository, turnContext });

  await assert.rejects(
    tool.execute('call_1', { generationId: 'generation_1', candidateId: 'candidate_bad' }),
  );
  assert.equal(turnContext.fatal, null);
});

test('generate_image returns terminate with a fatal code when the base asset is missing', async () => {
  const repository = createRepository();
  const imagesModels = createModels();
  const assetStorage = createStorage();
  const turnContext = createTurnContext({ projectId: 'project_1', turnId: 'turn_1', initialBaseAssetId: 'asset_gone', activeRevisionId: 'revision_1' });
  const tool = createGenerateImageTool({ repository, imagesModels, assetStorage, turnContext, config });

  const result = await tool.execute('call_1', { patch, renderPrompt: 'ivory coat' });
  assert.equal(result.terminate, true);
  assert.equal(result.details.fatalCode, 'ASSET_NOT_FOUND');
  assert.equal(turnContext.fatal.code, 'ASSET_NOT_FOUND');
  assert.equal(imagesModels.calls.length, 0);
  assert.equal(repository.generations.length, 0);
});

test('generate_image returns terminate with a fatal code when storage is unavailable', async () => {
  const repository = createRepository();
  const imagesModels = createModels();
  const assetStorage = createStorage({ getError: new Error('connect ECONNREFUSED') });
  const turnContext = createTurnContext({ projectId: 'project_1', turnId: 'turn_1', initialBaseAssetId: 'asset_base', activeRevisionId: 'revision_1' });
  const tool = createGenerateImageTool({ repository, imagesModels, assetStorage, turnContext, config });

  const result = await tool.execute('call_1', { patch, renderPrompt: 'ivory coat' });
  assert.equal(result.terminate, true);
  assert.equal(result.details.fatalCode, 'ASSET_STORAGE_UNAVAILABLE');
  assert.equal(imagesModels.calls.length, 0);
});

test('asset ids are unique across turns with the same per-turn index', async () => {
  const assetIds = [];
  for (const turnId of ['turn_1', 'turn_2']) {
    const repository = createRepository();
    const imagesModels = createModels();
    const turnContext = createTurnContext({ projectId: 'project_1', turnId, initialBaseAssetId: 'asset_base', activeRevisionId: 'revision_1' });
    const tool = createGenerateImageTool({ repository, imagesModels, assetStorage: createStorage(), turnContext, config });
    await tool.execute('call_1', { patch, renderPrompt: 'ivory coat' });
    assetIds.push(repository.generations[0].outcome.candidate.assetId);
  }
  assert.notEqual(assetIds[0], assetIds[1]);
  assert.ok(assetIds[0].includes('turn_1') && assetIds[1].includes('turn_2'));
});

test('generate_image records the turn id on the generation', async () => {
  const repository = createRepository();
  const turnContext = createTurnContext({ projectId: 'project_1', turnId: 'turn_9', initialBaseAssetId: 'asset_base', activeRevisionId: 'revision_1' });
  const tool = createGenerateImageTool({ repository, imagesModels: createModels(), assetStorage: createStorage(), turnContext, config });

  await tool.execute('call_1', { patch, renderPrompt: 'ivory coat' });
  assert.equal(repository.generations[0].turnId, 'turn_9');
});

test('generate_image emits a turn-attributed provider span', async () => {
  const spans = [];
  const telemetry = {
    startSpan: (options, callback) => {
      const span = { name: options.name, attrs: { ...options.attributes }, setAttributes(next) { Object.assign(span.attrs, next); }, addEvent() {}, setStatus() {}, startSpan() {} };
      spans.push(span);
      return callback(span);
    },
  };
  const repository = createRepository();
  const turnContext = createTurnContext({ projectId: 'project_1', turnId: 'turn_span', initialBaseAssetId: 'asset_base', activeRevisionId: 'revision_1' });
  const tool = createGenerateImageTool({ repository, imagesModels: createModels(), assetStorage: createStorage(), turnContext, config, telemetry });

  await tool.execute('call_1', { patch, renderPrompt: 'ivory coat' });

  const providerSpan = spans.find((span) => span.name === 'pi.ai.generate_images');
  assert.ok(providerSpan, 'provider span emitted');
  assert.equal(providerSpan.attrs['pi.turn.id'], 'turn_span');
  assert.equal(providerSpan.attrs['pi.project.id'], 'project_1');
  assert.equal(providerSpan.attrs['pi.model.id'], 'gpt-image-2');
});

test('transient provider failures consume attempts and the attempt cap stops the loop', async () => {
  const repository = createRepository();
  const imagesModels = createModels({ fail: 'transient' });
  const turnContext = createTurnContext({ projectId: 'project_1', turnId: 'turn_1', initialBaseAssetId: 'asset_base', activeRevisionId: 'revision_1' });
  const attemptConfig = { guards: { maxImagesPerTurn: 5, maxImageAttemptsPerTurn: 2 }, image: { modelId: 'gpt-image-2' } };
  const tool = createGenerateImageTool({ repository, imagesModels, assetStorage: createStorage(), turnContext, config: attemptConfig });

  await assert.rejects(tool.execute('call_1', { patch, renderPrompt: 'x' }), /503/);
  await assert.rejects(tool.execute('call_2', { patch, renderPrompt: 'x' }), /503/);
  await assert.rejects(
    tool.execute('call_3', { patch, renderPrompt: 'x' }),
    (error) => error.code === 'MAX_IMAGE_ATTEMPTS_REACHED',
  );
  assert.equal(imagesModels.calls.length, 2, '第三次在触达 provider 前就被闸住');
  assert.equal(turnContext.imageCount, 0, '成功配额未被失败消耗');
});

test('invalid patches do not consume image attempts', async () => {
  const repository = createRepository();
  const imagesModels = createModels();
  const turnContext = createTurnContext({ projectId: 'project_1', turnId: 'turn_1', initialBaseAssetId: 'asset_base', activeRevisionId: 'revision_1' });
  const attemptConfig = { guards: { maxImagesPerTurn: 2, maxImageAttemptsPerTurn: 1 }, image: { modelId: 'gpt-image-2' } };
  const tool = createGenerateImageTool({ repository, imagesModels, assetStorage: createStorage(), turnContext, config: attemptConfig });

  const badPatch = { modify: [{ path: 'not.allowed', operation: 'replace', value: 1 }] };
  await assert.rejects(tool.execute('call_1', { patch: badPatch, renderPrompt: 'x' }), { code: 'UNSAFE_STATE_PATH' });
  await assert.rejects(tool.execute('call_2', { patch: badPatch, renderPrompt: 'x' }), { code: 'UNSAFE_STATE_PATH' });

  const result = await tool.execute('call_3', { patch, renderPrompt: 'good' });
  assert.equal(result.terminate, undefined, '合法调用不受先前免费错误影响');
  assert.equal(turnContext.imageAttempts, 1);
  assert.equal(turnContext.imageCount, 1);
});
