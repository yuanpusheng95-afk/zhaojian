import assert from 'node:assert/strict';
import test from 'node:test';

import { createTurnViews } from '../src/api/turn-views.mjs';

function createDependencies({
  turn = null,
  generations = [],
  assets = new Map(),
  signError,
} = {}) {
  const pool = {
    async query(text, values) {
      if (text.includes('FROM agent_turns t')) {
        if (!turn || turn.id !== values[0] || turn.project_id !== values[1]) {
          return { rows: [] };
        }
        const selected = generations.filter((generation) => generation.selectedCandidateId).length;
        return { rows: [{
          turn_updated_at: turn.updated_at,
          generation_count: String(generations.length),
          selected_count: String(selected),
          generations_updated_at: generations.at(-1)?.updatedAt ?? null,
        }] };
      }
      if (text.includes('FROM agent_turns')) {
        if (!turn || turn.id !== values[0] || turn.project_id !== values[1]) {
          return { rows: [] };
        }
        return { rows: [turn] };
      }
      return { rows: [] };
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
    project_id: 'project_1',
    user_message: 'edit',
    status: 'running',
    outcome_json: null,
    error_json: null,
    created_at: new Date('2026-08-23T00:00:00Z'),
    updated_at: new Date('2026-08-23T00:00:01Z'),
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
