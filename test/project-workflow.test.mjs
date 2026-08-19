import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CandidateSelectionError,
  GenerationTransitionError,
  PhotoProjectService,
  ProjectBusyError,
  RevisionConflictError,
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

function createProject(service) {
  return service.createProject({
    projectId: 'project_1',
    name: 'Autumn portrait',
    initialState: initialState(),
    anchorAssetId: 'asset_source',
  });
}

function editPatch() {
  return {
    modify: [
      {
        path: 'appearance.outfit',
        operation: 'replace',
        value: 'ivory coat',
      },
    ],
    preserve: [
      { path: 'subject.identity', strength: 'hard' },
      { path: 'scene.background', strength: 'hard' },
    ],
  };
}

function advanceToCompleted(service, generationId) {
  for (const status of [
    'preparing',
    'submitted',
    'provider_processing',
    'verifying',
  ]) {
    service.transitionGeneration({ generationId, to: status });
  }
  service.addCandidate({
    generationId,
    candidateId: 'candidate_1',
    assetId: 'asset_generated_1',
    verification: {
      identity: { status: 'pass', score: 0.93 },
      backgroundPreserved: { status: 'pass' },
    },
  });
  service.transitionGeneration({ generationId, to: 'completed' });
}

test('creates a revision only after the user selects a generated candidate', () => {
  const service = createService();
  const project = createProject(service);

  const generation = service.requestGeneration({
    projectId: project.id,
    baseRevisionId: project.activeRevisionId,
    idempotencyKey: 'edit-1',
    patch: editPatch(),
  });

  assert.equal(generation.status, 'queued');
  assert.equal(generation.inputRevisionId, project.activeRevisionId);
  assert.equal(generation.proposedState.appearance.outfit, 'ivory coat');
  assert.equal(service.getProject(project.id).activeRevisionId, 'revision_1');
  assert.equal(service.listRevisions(project.id).length, 1);

  advanceToCompleted(service, generation.id);

  assert.equal(service.listRevisions(project.id).length, 1);

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

test('returns the original generation for the same idempotency key', () => {
  const service = createService();
  const project = createProject(service);
  const input = {
    projectId: project.id,
    baseRevisionId: project.activeRevisionId,
    idempotencyKey: 'edit-1',
    patch: editPatch(),
  };

  const first = service.requestGeneration(input);
  const second = service.requestGeneration(input);

  assert.equal(second.id, first.id);
  assert.equal(service.listGenerations(project.id).length, 1);
});

test('rejects a new generation while another project generation is active', () => {
  const service = createService();
  const project = createProject(service);

  service.requestGeneration({
    projectId: project.id,
    baseRevisionId: project.activeRevisionId,
    idempotencyKey: 'edit-1',
    patch: editPatch(),
  });

  assert.throws(
    () =>
      service.requestGeneration({
        projectId: project.id,
        baseRevisionId: project.activeRevisionId,
        idempotencyKey: 'edit-2',
        patch: editPatch(),
      }),
    ProjectBusyError,
  );
});

test('rejects an edit based on a stale revision', () => {
  const service = createService();
  const project = createProject(service);

  assert.throws(
    () =>
      service.requestGeneration({
        projectId: project.id,
        baseRevisionId: 'revision_stale',
        idempotencyKey: 'edit-1',
        patch: editPatch(),
      }),
    RevisionConflictError,
  );
});

test('rejects generation status jumps that bypass required states', () => {
  const service = createService();
  const project = createProject(service);
  const generation = service.requestGeneration({
    projectId: project.id,
    baseRevisionId: project.activeRevisionId,
    idempotencyKey: 'edit-1',
    patch: editPatch(),
  });

  assert.throws(
    () =>
      service.transitionGeneration({
        generationId: generation.id,
        to: 'completed',
      }),
    GenerationTransitionError,
  );
});

test('selecting the same candidate is idempotent but selecting another is rejected', () => {
  const service = createService();
  const project = createProject(service);
  const generation = service.requestGeneration({
    projectId: project.id,
    baseRevisionId: project.activeRevisionId,
    idempotencyKey: 'edit-1',
    patch: editPatch(),
  });

  for (const status of [
    'preparing',
    'submitted',
    'provider_processing',
    'verifying',
  ]) {
    service.transitionGeneration({ generationId: generation.id, to: status });
  }
  service.addCandidate({
    generationId: generation.id,
    candidateId: 'candidate_1',
    assetId: 'asset_generated_1',
    verification: {},
  });
  service.addCandidate({
    generationId: generation.id,
    candidateId: 'candidate_2',
    assetId: 'asset_generated_2',
    verification: {},
  });
  service.transitionGeneration({ generationId: generation.id, to: 'completed' });

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
        candidateId: 'candidate_2',
      }),
    CandidateSelectionError,
  );
});

test('rejects reusing an idempotency key for a different request', () => {
  const service = createService();
  const project = createProject(service);

  service.requestGeneration({
    projectId: project.id,
    baseRevisionId: project.activeRevisionId,
    idempotencyKey: 'edit-1',
    patch: editPatch(),
  });

  const differentPatch = editPatch();
  differentPatch.modify[0].value = 'red coat';

  assert.throws(
    () =>
      service.requestGeneration({
        projectId: project.id,
        baseRevisionId: project.activeRevisionId,
        idempotencyKey: 'edit-1',
        patch: differentPatch,
      }),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
});

test('releases the project lock when a generation fails', () => {
  const service = createService();
  const project = createProject(service);
  const failed = service.requestGeneration({
    projectId: project.id,
    baseRevisionId: project.activeRevisionId,
    idempotencyKey: 'edit-1',
    patch: editPatch(),
  });

  service.transitionGeneration({ generationId: failed.id, to: 'failed' });

  const retry = service.requestGeneration({
    projectId: project.id,
    baseRevisionId: project.activeRevisionId,
    idempotencyKey: 'edit-2',
    patch: editPatch(),
  });

  assert.equal(retry.status, 'queued');
  assert.notEqual(retry.id, failed.id);
});

test('does not allow an older completed generation to change the active revision while another generation runs', () => {
  const service = createService();
  const project = createProject(service);
  const first = service.requestGeneration({
    projectId: project.id,
    baseRevisionId: project.activeRevisionId,
    idempotencyKey: 'edit-1',
    patch: editPatch(),
  });
  advanceToCompleted(service, first.id);

  service.requestGeneration({
    projectId: project.id,
    baseRevisionId: project.activeRevisionId,
    idempotencyKey: 'edit-2',
    patch: editPatch(),
  });

  assert.throws(
    () =>
      service.selectCandidate({
        projectId: project.id,
        generationId: first.id,
        candidateId: 'candidate_1',
      }),
    ProjectBusyError,
  );
});

test('requires an idempotency key for every generation request', () => {
  const service = createService();
  const project = createProject(service);

  assert.throws(
    () =>
      service.requestGeneration({
        projectId: project.id,
        baseRevisionId: project.activeRevisionId,
        patch: editPatch(),
      }),
    { code: 'INVALID_GENERATION_REQUEST' },
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
