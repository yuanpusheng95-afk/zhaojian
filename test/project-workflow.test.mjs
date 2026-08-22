import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CandidateSelectionError,
  PhotoProjectService,
  RevisionConflictError,
  RevisionNotFoundError,
} from '../src/domain/photo-project-service.mjs';

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
  return new PhotoProjectService({
    idFactory: createIdFactory(),
    now: () => '2026-08-19T14:40:00+08:00',
  });
}

function createProject(service, projectId = 'project_1') {
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

function recordGeneration(service, project, patch = editPatch(), options = {}) {
  const baseRevisionId =
    options.baseRevisionId ?? service.getProject(project.id).activeRevisionId;
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

test('creates a revision only after the user selects a generated candidate', () => {
  const service = createService();
  const project = createProject(service);

  const generation = recordGeneration(service, project);

  assert.equal(generation.status, 'completed');
  assert.equal(generation.inputRevisionId, project.activeRevisionId);
  assert.equal(generation.proposedState.appearance.outfit, 'ivory coat');
  assert.equal(service.getProject(project.id).activeRevisionId, 'revision_1');
  assert.equal(service.listRevisions(project.id).length, 1);
  assert.deepEqual(generation.candidates, [{
    id: 'candidate_1',
    assetId: 'asset_generated_1',
    verification: {},
    createdAt: generation.createdAt,
  }]);

  const revision = service.selectCandidate({
    projectId: project.id,
    generationId: generation.id,
    candidateId: 'candidate_1',
  });

  assert.equal(revision.parentRevisionId, 'revision_1');
  assert.equal(revision.anchorAssetId, 'asset_generated_1');
  assert.equal(revision.state.appearance.outfit, 'ivory coat');
  assert.equal(service.getProject(project.id).activeRevisionId, revision.id);
  assert.equal(service.listRevisions(project.id).length, 2);
});

test('allows a second generation with an identical patch in the same turn', () => {
  const service = createService();
  const project = createProject(service);
  const request = { patch: editPatch() };

  const first = recordGeneration(service, project, request.patch);
  const second = recordGeneration(service, project, request.patch);

  assert.notEqual(second.id, first.id);
  assert.deepEqual(
    service.listGenerations(project.id).map(({ id }) => id),
    [first.id, second.id],
  );
});

test('rejects an edit based on a missing revision', () => {
  const service = createService();
  const project = createProject(service);

  assert.throws(
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

test('records a failed generation without candidates', () => {
  const service = createService();
  const project = createProject(service);

  const generation = service.recordGeneration({
    projectId: project.id,
    turnId: 'turn_1',
    baseRevisionId: service.getProject(project.id).activeRevisionId,
    inputAssetId: 'asset_source',
    patch: editPatch(),
    outcome: { kind: 'failed', error: { message: 'provider unavailable' } },
  });

  assert.equal(generation.status, 'failed');
  assert.deepEqual(generation.candidates, []);
  assert.deepEqual(generation.error, { message: 'provider unavailable' });
});

test('selecting the same candidate is idempotent but another is rejected', () => {
  const service = createService();
  const project = createProject(service);
  const generation = recordGeneration(service, project);

  const first = service.selectCandidate({
    projectId: project.id,
    generationId: generation.id,
    candidateId: 'candidate_1',
  });
  const repeated = service.selectCandidate({
    projectId: project.id,
    generationId: generation.id,
    candidateId: 'candidate_1',
  });

  assert.equal(repeated.id, first.id);
  assert.throws(
    () =>
      service.selectCandidate({
        projectId: project.id,
        generationId: generation.id,
        candidateId: 'candidate_missing',
      }),
    CandidateSelectionError,
  );
});

test('rejects selecting a completed generation after the active revision advanced', () => {
  const service = createService();
  const project = createProject(service);

  const first = recordGeneration(service, project, editPatch('ivory coat'), {
    turnId: 'turn_1',
  });
  const second = recordGeneration(service, project, editPatch('wool coat'), {
    turnId: 'turn_2',
  });

  service.selectCandidate({
    projectId: project.id,
    generationId: first.id,
    candidateId: 'candidate_1',
  });

  assert.throws(
    () =>
      service.selectCandidate({
        projectId: project.id,
        generationId: second.id,
        candidateId: 'candidate_2',
      }),
    RevisionConflictError,
  );
});

test('rejects invalid patches before recording a generation', () => {
  const service = createService();
  const project = createProject(service);

  assert.throws(
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

test('reports a missing revision as not found', () => {
  const service = createService();

  const project = createProject(service);
  service.selectCandidate({
    projectId: project.id,
    generationId: recordGeneration(service, project).id,
    candidateId: 'candidate_1',
  });

  assert.throws(
    () => service.getRevision('revision_missing'),
    (error) => error.code === 'REVISION_NOT_FOUND',
  );
  assert.throws(
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

test('rejects a project whose initial photo state is invalid', () => {
  const service = createService();

  assert.throws(
    () =>
      service.createProject({
        projectId: 'project_invalid',
        name: 'Invalid project',
        initialState: null,
      }),
    { code: 'INVALID_STATE_PATCH' },
  );
});
