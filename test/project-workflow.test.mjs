import assert from 'node:assert/strict';
import { describe, expect, test } from 'bun:test';

import {
  CandidateSelectionError,
  InMemoryPhotoProjectRepository,
  RevisionConflictError,
  RevisionNotFoundError,
} from '../src/domain/photo-project-service.js';

function createIdFactory() {
  const counters = new Map();
  return (prefix) => {
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    return `${prefix}_${next}`;
  };
}

function initialState() {
  return {
    subject: {
      personId: 'person_1',
      identity: { preserve: true },
    },
    scene: { location: 'studio' },
    appearance: { outfit: 'black jacket' },
    composition: { shot: 'medium' },
    constraints: [],
  };
}

function createService() {
  return new InMemoryPhotoProjectRepository({
    idFactory: createIdFactory(),
    now: () => '2026-08-19T14:40:00+08:00',
  });
}

async function createProject(service, projectId = 'project_1') {
  return service.createProject({
    projectId,
    name: 'Autumn portrait',
    initialState: initialState(),
    anchorAsset: { assetId: 'asset_source' },
  });
}

function editPatch(value = 'ivory coat') {
  return {
    modify: [
      { path: 'appearance.outfit', operation: 'replace', value },
    ],
    preserve: [
      { path: 'subject.identity', strength: 'hard' },
      { path: 'scene.background', strength: 'hard' },
    ],
  };
}

async function recordGeneration(service, project, patch = editPatch(), options = {}) {
  const current = await service.getProject(project.id);
  const baseRevisionId = options.baseRevisionId ?? current.activeRevisionId;
  return service.recordGeneration({
    projectId: project.id,
    turnId: options.turnId ?? 'turn_1',
    baseRevisionId,
    inputAssetId: 'asset_source',
    patch,
    outcome: {
      kind: 'completed',
      candidate: { assetId: 'asset_generated_1' },
    },
  });
}

test('creates a revision only after the user selects a generated candidate', async () => {
  const service = createService();
  const project = await createProject(service);

  const generation = await recordGeneration(service, project);

  assert.equal(generation.status, 'completed');
  assert.equal(generation.inputRevisionId, project.activeRevisionId);
  assert.equal(generation.proposedState.appearance.outfit, 'ivory coat');
  assert.equal((await service.getProject(project.id)).activeRevisionId, 'revision_1');
  assert.equal((await service.listRevisions(project.id)).length, 1);
  assert.deepEqual(generation.candidates, [{
    id: 'candidate_1',
    assetId: 'asset_generated_1',
    verification: {},
    createdAt: generation.createdAt,
  }]);

  const revision = await service.selectCandidate({
    projectId: project.id,
    generationId: generation.id,
    candidateId: 'candidate_1',
  });

  assert.equal(revision.parentRevisionId, 'revision_1');
  assert.equal(revision.anchorAssetId, 'asset_generated_1');
  assert.equal(revision.state.appearance.outfit, 'ivory coat');
  assert.equal((await service.getProject(project.id)).activeRevisionId, revision.id);
  assert.equal((await service.listRevisions(project.id)).length, 2);
});

test('allows a second generation with an identical patch in the same turn', async () => {
  const service = createService();
  const project = await createProject(service);
  const request = { patch: editPatch() };

  const first = await recordGeneration(service, project, request.patch);
  const second = await recordGeneration(service, project, request.patch);

  assert.notEqual(second.id, first.id);
  assert.deepEqual(
    (await service.listGenerations(project.id)).map(({ id }) => id),
    [first.id, second.id],
  );
});

test('rejects an edit based on a missing revision', async () => {
  const service = createService();
  const project = await createProject(service);

  await assert.rejects(
    () =>
      service.recordGeneration({
        projectId: project.id,
        turnId: 'turn_1',
        baseRevisionId: 'revision_stale',
        inputAssetId: 'asset_source',
        patch: editPatch(),
        outcome: {
          kind: 'completed',
          candidate: { assetId: 'asset_generated_1' },
        },
      }),
    RevisionNotFoundError,
  );
});

test('records a failed generation without candidates', async () => {
  const service = createService();
  const project = await createProject(service);

  const generation = await service.recordGeneration({
    projectId: project.id,
    turnId: 'turn_1',
    baseRevisionId: (await service.getProject(project.id)).activeRevisionId,
    inputAssetId: 'asset_source',
    patch: editPatch(),
    outcome: { kind: 'failed', error: { message: 'provider unavailable' } },
  });

  assert.equal(generation.status, 'failed');
  assert.deepEqual(generation.candidates, []);
  assert.deepEqual(generation.error, { message: 'provider unavailable' });
});

test('selecting the same candidate is idempotent but another is rejected', async () => {
  const service = createService();
  const project = await createProject(service);
  const generation = await recordGeneration(service, project);

  const first = await service.selectCandidate({
    projectId: project.id,
    generationId: generation.id,
    candidateId: 'candidate_1',
  });
  const repeated = await service.selectCandidate({
    projectId: project.id,
    generationId: generation.id,
    candidateId: 'candidate_1',
  });

  assert.equal(repeated.id, first.id);
  await assert.rejects(
    () =>
      service.selectCandidate({
        projectId: project.id,
        generationId: generation.id,
        candidateId: 'candidate_missing',
      }),
    CandidateSelectionError,
  );
});

test('rejects selecting a completed generation after the active revision advanced', async () => {
  const service = createService();
  const project = await createProject(service);
  const first = await recordGeneration(service, project, editPatch('ivory coat'), {
    turnId: 'turn_1',
  });
  const second = await recordGeneration(service, project, editPatch('wool coat'), {
    turnId: 'turn_2',
  });

  await service.selectCandidate({
    projectId: project.id,
    generationId: first.id,
    candidateId: 'candidate_1',
  });

  await assert.rejects(
    () =>
      service.selectCandidate({
        projectId: project.id,
        generationId: second.id,
        candidateId: 'candidate_2',
      }),
    RevisionConflictError,
  );
});

test('rejects invalid patches before recording a generation', async () => {
  const service = createService();
  const project = await createProject(service);

  await assert.rejects(
    () =>
      service.recordGeneration({
        projectId: project.id,
        turnId: 'turn_1',
        baseRevisionId: project.activeRevisionId,
        inputAssetId: 'asset_source',
        patch: {
          modify: [{ path: 'account.balance', operation: 'replace', value: 0 }],
          preserve: [],
        },
        outcome: {
          kind: 'completed',
          candidate: { assetId: 'asset_generated_1' },
        },
      }),
    { code: 'UNSAFE_STATE_PATH' },
  );
});

test('reports a missing revision as not found', async () => {
  const service = createService();

  const project = await createProject(service);
  await service.selectCandidate({
    projectId: project.id,
    generationId: (await recordGeneration(service, project)).id,
    candidateId: 'candidate_1',
  });

  await assert.rejects(
    () => service.getRevision('revision_missing'),
    (error) => error.code === 'REVISION_NOT_FOUND',
  );
  await assert.rejects(
    () =>
      service.recordGeneration({
        projectId: project.id,
        turnId: 'turn_1',
        baseRevisionId: 'revision_stale',
        inputAssetId: 'asset_source',
        patch: editPatch(),
        outcome: { kind: 'completed', candidate: { assetId: 'asset_generated_1' } },
      }),
    RevisionNotFoundError,
  );
});

test('rejects a project whose initial photo state is invalid', async () => {
  const service = createService();

  await assert.rejects(
    () =>
      service.createProject({
        projectId: 'project_invalid',
        name: 'Invalid project',
        initialState: null,
      }),
    { code: 'INVALID_STATE_PATCH' },
  );
});

test('records and reads assets through the same port', async () => {
  const service = createService();

  const asset = await service.recordAsset({
    assetId: 'upload_1',
    uri: 's3://photo-agent/users/dev/uploads/upload_1.png',
    metadata: { contentType: 'image/png' },
  });

  assert.deepEqual(asset, {
    id: 'upload_1',
    kind: 'source',
    uri: 's3://photo-agent/users/dev/uploads/upload_1.png',
    metadata: { contentType: 'image/png' },
  });
  assert.deepEqual(await service.getAsset('upload_1'), asset);
  await assert.rejects(
    () => service.getAsset('missing'),
    (error) => error.code === 'ASSET_NOT_FOUND',
  );
});

test('lists generations scoped by turn', async () => {
  const service = createService();
  const project = await createProject(service);
  await recordGeneration(service, project, editPatch(), { turnId: 'turn_1' });
  await recordGeneration(service, project, editPatch(), { turnId: 'turn_2' });

  const scoped = await service.listGenerationsByTurn({ projectId: project.id, turnId: 'turn_1' });
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].turnId, 'turn_1');
});
