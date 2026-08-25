import assert from 'node:assert/strict';
import { describe, expect, test } from 'bun:test';

import { createTurnViews } from '../src/api/turn-views.js';

let connect;

function createDependencies({
  turn = null,
  generations = [],
  assets = new Map(),
  signError,
} = {}) {
  connect = async () => ({
        async query(queryOrText, values = []) {
          const text = typeof queryOrText === 'string' ? queryOrText : queryOrText.text;
          const rowMode = typeof queryOrText === 'object' ? queryOrText.rowMode : undefined;
          const boundValues = typeof queryOrText === 'object' && Array.isArray(queryOrText.values)
            ? queryOrText.values
            : values;
          if (text.includes('max("agent_turns"."updated_at")')) {
            return {
              rows: turn && turn.id === boundValues[0] && turn.projectId === boundValues[1]
                ? [[
                    turn.updatedAt.toISOString(),
                    generations.at(-1)?.updatedAt?.toISOString() ?? null,
                    generations.length,
                    generations.filter((generation) => generation.selectedCandidateId).length,
                  ]]
                : [],
            };
          }
          const matched = turn && turn.id === boundValues[0] && turn.projectId === boundValues[1];
          const objectRow = matched ? {
            id: turn.id,
            projectId: turn.projectId,
            status: turn.status,
            userMessage: turn.userMessage,
            error_json: turn.errorJson,
            outcome_json: turn.outcomeJson,
            created_at: turn.createdAt,
            updated_at: turn.updatedAt,
          } : null;
          if (objectRow && rowMode === 'array') {
            return { rows: [[
              turn.id,
              turn.projectId,
              turn.userMessage,
              null,
              turn.status,
              null,
              null,
              turn.errorJson,
              turn.outcomeJson,
              turn.createdAt,
              turn.updatedAt,
            ]] };
          }
          return { rows: objectRow ? [objectRow] : [] };
        },
        release() {},
      });

  const pool = {
    async query(text, values = []) {
      return await (await connect()).query(text, values);
    },
  };
  const repository = {
    async listGenerationsByTurn({ projectId, turnId }) {
      return generations;
    },
    async getAsset(assetId) {
      const asset = assets.get(assetId);
      if (!asset) {
        const error = new Error(`Asset not found: ${assetId}`);
        error.code = 'ASSET_NOT_FOUND';
        throw error;
      }
      return asset;
    },
  };
  const assetStorage = {
    bucket: 'photo-agent',
    async getSignedUrl(key, options) {
      if (signError) throw signError;
      return `https://signed.test/${key}?ttl=${options.expiresInSeconds}`;
    },
  };
  return { pool, repository, assetStorage };
}

const completedGeneration = {
  id: 'generation_1',
  turnId: 'turn_1',
  status: 'completed',
  patch: { modify: [], preserve: [] },
  renderPrompt: 'ivory coat',
  candidates: [{ id: 'candidate_1', assetId: 'asset_1' }],
  selectedCandidateId: null,
  selectedRevisionId: null,
};

function baseTurn() {
  return {
    id: 'turn_1',
    projectId: 'project_1',
    userMessage: 'edit',
    status: 'running',
    outcomeJson: null,
    errorJson: null,
    createdAt: new Date('2026-08-23T00:00:00Z'),
    updatedAt: new Date('2026-08-23T00:00:01Z'),
  };
}

function createViews(dependencies = {}) {
  return createTurnViews({
    ...createDependencies(dependencies),
    signedUrlTtlSeconds: 60,
  });
}

test('loadTurnDetail signs the candidate and maps generation fields', async () => {
  const assets = new Map([['asset_1', {
    uri: 's3://photo-agent/base.png',
    metadata: { contentType: 'image/png' },
  }]]);
  const views = createViews({
    turn: baseTurn(),
    generations: [completedGeneration],
    assets,
  });

  assert.deepEqual(await views.loadTurnDetail({ projectId: 'project_1', turnId: 'turn_1' }), {
    turnId: 'turn_1',
    projectId: 'project_1',
    status: 'running',
    userMessage: 'edit',
    error: null,
    outcome: null,
    generations: [{
      generationId: 'generation_1',
      status: 'completed',
      patch: { modify: [], preserve: [] },
      renderPrompt: 'ivory coat',
      selectedCandidateId: null,
      selectedRevisionId: null,
      candidate: {
        id: 'candidate_1',
        assetId: 'asset_1',
        url: 'https://signed.test/base.png?ttl=60',
        contentType: 'image/png',
      },
    }],
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T00:00:01.000Z',
  });
});

test('loadTurnDetail degrades a missing candidate asset without hiding other fields', async () => {
  const views = createViews({
    turn: baseTurn(),
    generations: [completedGeneration],
    assets: new Map(),
  });
  const detail = await views.loadTurnDetail({ projectId: 'project_1', turnId: 'turn_1' });

  assert.equal(detail.generations[0].candidate.url, null);
  assert.equal(detail.generations[0].candidate.urlError, 'Asset not found: asset_1');
  assert.equal(detail.status, 'running');
});

test('loadTurnDetail surfaces storage failures instead of degrading the view', async () => {
  const views = createViews({
    turn: baseTurn(),
    generations: [completedGeneration],
    assets: new Map([['asset_1', { uri: 's3://photo-agent/base.png', metadata: {} }]]),
    signError: new Error('storage unavailable'),
  });

  await assert.rejects(
    () => views.loadTurnDetail({ projectId: 'project_1', turnId: 'turn_1' }),
    /storage unavailable/,
  );
});

test('loadTurnDetail surfaces malformed asset uris instead of degrading the view', async () => {
  const views = createViews({
    turn: baseTurn(),
    generations: [completedGeneration],
    assets: new Map([['asset_1', { uri: 'bare-key.png', metadata: {} }]]),
  });

  await assert.rejects(
    () => views.loadTurnDetail({ projectId: 'project_1', turnId: 'turn_1' }),
    (error) => error.code === 'INVALID_ASSET_URI',
  );
});

test('loadTurnDetail rejects a cross-project turn id', async () => {
  const views = createViews({ turn: baseTurn() });
  await assert.rejects(
    () => views.loadTurnDetail({ projectId: 'other', turnId: 'turn_1' }),
    (error) => error.code === 'TURN_NOT_FOUND',
  );
});

test('fingerprint detects generation updates and selection changes', async () => {
  const first = createViews({
    turn: baseTurn(),
    generations: [completedGeneration],
  });
  const initial = await first.turnChangedSince({ projectId: 'project_1', turnId: 'turn_1', lastFingerprint: null });
  assert.equal(initial.changed, true);

  const selected = {
    ...completedGeneration,
    selectedCandidateId: 'candidate_1',
    selectedRevisionId: 'revision_1',
  };
  const second = createViews({
    turn: baseTurn(),
    generations: [selected],
  });
  const changed = await second.turnChangedSince({
    projectId: 'project_1', turnId: 'turn_1', lastFingerprint: initial.fingerprint,
  });
  assert.equal(changed.changed, true);
});
