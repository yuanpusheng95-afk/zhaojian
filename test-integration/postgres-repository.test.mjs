import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';

import pg from 'pg';

import {
  ProjectBusyError,
  RevisionConflictError,
} from '../src/domain/photo-project-service.mjs';
import {
  EditInterpretationFailedError,
  EditInterpreter,
} from '../src/application/edit-interpreter.mjs';
import { MockLanguageModel } from '../src/application/mock-language-model.mjs';
import { runMigrations } from '../src/infrastructure/postgres/migrate.mjs';
import {
  GenerationLeaseLostError,
  PostgresPhotoProjectRepository,
  ProviderJobConflictError,
} from '../src/infrastructure/postgres/photo-project-repository.mjs';
import { PostgresGenerationQueue } from '../src/infrastructure/postgres/generation-queue.mjs';
import { GenerationWorker } from '../src/worker/generation-worker.mjs';
import { MockImageProvider } from '../src/worker/mock-image-provider.mjs';
import { createApiServer } from '../src/api/server.mjs';

const { Pool } = pg;
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    'postgres://photo_agent:photo_agent@127.0.0.1:54329/photo_agent_test',
});

beforeEach(async () => {
  const database = await pool.query('SELECT current_database() AS name');
  if (!database.rows[0].name.endsWith('_test')) {
    throw new Error(
      `Refusing to reset non-test database: ${database.rows[0].name}`,
    );
  }
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations(pool);
});

after(async () => {
  await pool.end();
});

function createIdFactory() {
  const counters = new Map();
  return (prefix) => {
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    return `${prefix}_${next}`;
  };
}

function createRepository() {
  return new PostgresPhotoProjectRepository({
    pool,
    idFactory: createIdFactory(),
    now: () => '2026-08-19T06:40:00.000Z',
  });
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

function editPatch(value = 'ivory coat') {
  return {
    modify: [
      {
        path: 'appearance.outfit',
        operation: 'replace',
        value,
      },
    ],
    preserve: [
      { path: 'subject.identity', strength: 'hard' },
      { path: 'scene.background', strength: 'hard' },
    ],
  };
}

async function createProject(repository) {
  return repository.createProject({
    projectId: 'project_1',
    name: 'Autumn portrait',
    initialState: initialState(),
    anchorAssetId: 'asset_source',
  });
}

test('migration creates the persistence tables', async () => {
  const result = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `);

  assert.deepEqual(
    result.rows.map((row) => row.table_name),
    [
      'assets',
      'generation_jobs',
      'generation_outputs',
      'idempotency_requests',
      'photo_revisions',
      'projects',
      'schema_migrations',
    ],
  );
});

test('creates a project and its initial revision atomically', async () => {
  const repository = createRepository();
  const project = await createProject(repository);
  const revision = await repository.getRevision(project.activeRevisionId);

  assert.equal(project.id, 'project_1');
  assert.equal(project.runningGenerationId, null);
  assert.equal(revision.projectId, project.id);
  assert.equal(revision.parentRevisionId, null);
  assert.equal(revision.anchorAssetId, 'asset_source');
  assert.deepEqual(revision.state, initialState());
});

test('persists idempotency, stale-revision checks, and the project generation lock', async () => {
  const repository = createRepository();
  const project = await createProject(repository);
  const request = {
    projectId: project.id,
    baseRevisionId: project.activeRevisionId,
    idempotencyKey: 'edit-1',
    patch: editPatch(),
  };

  const first = await repository.requestGeneration(request);
  const repeated = await repository.requestGeneration(request);

  assert.equal(repeated.id, first.id);
  assert.equal(first.status, 'queued');
  assert.equal(first.proposedState.appearance.outfit, 'ivory coat');

  await assert.rejects(
    repository.requestGeneration({
      ...request,
      idempotencyKey: 'edit-2',
    }),
    ProjectBusyError,
  );

  await repository.transitionGeneration({
    generationId: first.id,
    to: 'failed',
  });

  await assert.rejects(
    repository.requestGeneration({
      ...request,
      baseRevisionId: 'revision_stale',
      idempotencyKey: 'edit-3',
    }),
    RevisionConflictError,
  );
});

test('serializes concurrent generation requests for one project', async () => {
  const repository = createRepository();
  const project = await createProject(repository);

  const results = await Promise.allSettled([
    repository.requestGeneration({
      projectId: project.id,
      baseRevisionId: project.activeRevisionId,
      idempotencyKey: 'edit-a',
      patch: editPatch('ivory coat'),
    }),
    repository.requestGeneration({
      projectId: project.id,
      baseRevisionId: project.activeRevisionId,
      idempotencyKey: 'edit-b',
      patch: editPatch('red coat'),
    }),
  ]);

  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  const rejected = results.find((result) => result.status === 'rejected');
  assert.ok(rejected.reason instanceof ProjectBusyError);
});

test('creates and activates a revision only when a completed candidate is selected', async () => {
  const repository = createRepository();
  const project = await createProject(repository);
  const generation = await repository.requestGeneration({
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
    await repository.transitionGeneration({
      generationId: generation.id,
      to: status,
    });
  }
  await repository.addCandidate({
    generationId: generation.id,
    candidateId: 'candidate_1',
    assetId: 'asset_generated_1',
    verification: { identity: { status: 'pass', score: 0.93 } },
  });
  await repository.transitionGeneration({
    generationId: generation.id,
    to: 'completed',
  });

  assert.equal((await repository.listRevisions(project.id)).length, 1);

  const revision = await repository.selectCandidate({
    projectId: project.id,
    generationId: generation.id,
    candidateId: 'candidate_1',
  });
  const updatedProject = await repository.getProject(project.id);

  assert.equal(revision.parentRevisionId, project.activeRevisionId);
  assert.equal(revision.anchorAssetId, 'asset_generated_1');
  assert.equal(revision.state.appearance.outfit, 'ivory coat');
  assert.equal(updatedProject.activeRevisionId, revision.id);
  assert.equal((await repository.listRevisions(project.id)).length, 2);

  const repeated = await repository.selectCandidate({
    projectId: project.id,
    generationId: generation.id,
    candidateId: 'candidate_1',
  });
  assert.equal(repeated.id, revision.id);
});


test('claims queued generations exactly once with SKIP LOCKED semantics', async () => {
  const repository = createRepository();
  const firstProject = await repository.createProject({
    projectId: 'project_queue_1',
    name: 'First queue project',
    initialState: initialState(),
  });
  const secondProject = await repository.createProject({
    projectId: 'project_queue_2',
    name: 'Second queue project',
    initialState: initialState(),
  });
  await repository.requestGeneration({
    projectId: firstProject.id,
    baseRevisionId: firstProject.activeRevisionId,
    idempotencyKey: 'queue-1',
    patch: editPatch(),
  });
  await repository.requestGeneration({
    projectId: secondProject.id,
    baseRevisionId: secondProject.activeRevisionId,
    idempotencyKey: 'queue-2',
    patch: editPatch(),
  });

  const queue = new PostgresGenerationQueue({
    pool,
    repository,
    now: () => '2026-08-19T06:41:00.000Z',
  });
  const [first, second] = await Promise.all([
    queue.claimNext(),
    queue.claimNext(),
  ]);

  assert.notEqual(first.id, second.id);
  assert.equal(first.status, 'preparing');
  assert.equal(second.status, 'preparing');
  assert.equal(await queue.claimNext(), null);
});

test('mock worker completes a generation but leaves revision creation to the user', async () => {
  const repository = createRepository();
  const project = await createProject(repository);
  const generation = await repository.requestGeneration({
    projectId: project.id,
    baseRevisionId: project.activeRevisionId,
    idempotencyKey: 'worker-1',
    patch: editPatch(),
  });
  const queue = new PostgresGenerationQueue({ pool, repository });
  const worker = new GenerationWorker({
    queue,
    repository,
    provider: new MockImageProvider(),
  });

  const completed = await worker.runOnce();
  const updatedProject = await repository.getProject(project.id);

  assert.equal(completed.id, generation.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.candidates.length, 1);
  assert.equal(completed.candidates[0].assetId, `asset_${generation.id}`);
  assert.equal(updatedProject.runningGenerationId, null);
  assert.equal(updatedProject.activeRevisionId, project.activeRevisionId);
  assert.equal((await repository.listRevisions(project.id)).length, 1);
});

test('worker marks a provider failure and releases the project generation lock', async () => {
  const repository = createRepository();
  const project = await createProject(repository);
  const generation = await repository.requestGeneration({
    projectId: project.id,
    baseRevisionId: project.activeRevisionId,
    idempotencyKey: 'worker-failure',
    patch: editPatch(),
  });
  const queue = new PostgresGenerationQueue({ pool, repository });
  const worker = new GenerationWorker({
    queue,
    repository,
    provider: {
      capability: 'image_generation',
      providerName: 'failing',
      modelName: 'failing-image-v1',
      async submit() {
        return { jobId: 'failing_job_1' };
      },
      async waitForResult() {
        throw new Error('provider unavailable');
      },
    },
  });

  const failed = await worker.runOnce();
  const updatedProject = await repository.getProject(project.id);

  assert.equal(failed.id, generation.id);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.error, { message: 'provider unavailable' });
  assert.equal(updatedProject.runningGenerationId, null);
});


test('HTTP API exposes the persisted generation and selection vertical slice', async (t) => {
  const repository = createRepository();
  const server = createApiServer({ repository });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let response = await fetch(`${baseUrl}/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: 'project_api',
      name: 'API portrait',
      initialState: initialState(),
      anchorAssetId: 'asset_api_source',
    }),
  });
  assert.equal(response.status, 201);
  const project = await response.json();

  response = await fetch(`${baseUrl}/projects/${project.id}/generations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'api-edit-1',
    },
    body: JSON.stringify({
      baseRevisionId: project.activeRevisionId,
      patch: editPatch(),
    }),
  });
  assert.equal(response.status, 202);
  const generation = await response.json();
  assert.equal(generation.status, 'queued');

  const worker = new GenerationWorker({
    queue: new PostgresGenerationQueue({ pool, repository }),
    repository,
    provider: new MockImageProvider(),
  });
  await worker.runOnce();

  response = await fetch(`${baseUrl}/generations/${generation.id}`);
  assert.equal(response.status, 200);
  const completed = await response.json();
  assert.equal(completed.status, 'completed');
  assert.equal(completed.candidates.length, 1);

  response = await fetch(
    `${baseUrl}/projects/${project.id}/generations/${generation.id}/selections`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ candidateId: completed.candidates[0].id }),
    },
  );
  assert.equal(response.status, 201);
  const revision = await response.json();

  response = await fetch(`${baseUrl}/projects/${project.id}`);
  assert.equal(response.status, 200);
  const updatedProject = await response.json();
  assert.equal(updatedProject.activeRevisionId, revision.id);
});

test('HTTP API maps domain conflicts and invalid JSON without leaking internals', async (t) => {
  const repository = createRepository();
  const project = await createProject(repository);
  const server = createApiServer({ repository });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let response = await fetch(`${baseUrl}/projects/${project.id}/generations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'api-stale',
    },
    body: JSON.stringify({
      baseRevisionId: 'revision_stale',
      patch: editPatch(),
    }),
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: {
      code: 'REVISION_CONFLICT',
      message:
        'Revision conflict for project project_1: expected revision_stale, active revision_1',
    },
  });

  response = await fetch(`${baseUrl}/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{broken',
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' },
  });

  response = await fetch(`${baseUrl}/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: project.id,
      name: 'Duplicate project',
      initialState: initialState(),
    }),
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: {
      code: 'RESOURCE_CONFLICT',
      message: 'Resource already exists',
    },
  });
});


test('migration adds generation lease fields', async () => {
  const result = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'generation_jobs'
      AND column_name IN (
        'claim_token',
        'claimed_at',
        'lease_expires_at',
        'attempt_count'
      )
    ORDER BY column_name
  `);

  assert.deepEqual(
    result.rows.map((row) => row.column_name),
    ['attempt_count', 'claim_token', 'claimed_at', 'lease_expires_at'],
  );
});

test('reclaims an expired generation and rejects writes from the stale worker', async () => {
  const repository = createRepository();
  const project = await createProject(repository);
  const generation = await repository.requestGeneration({
    projectId: project.id,
    baseRevisionId: project.activeRevisionId,
    idempotencyKey: 'lease-reclaim',
    patch: editPatch(),
  });
  const firstQueue = new PostgresGenerationQueue({
    pool,
    repository,
    now: () => '2026-08-19T06:40:00.000Z',
    leaseDurationMs: 1_000,
    tokenFactory: () => 'lease_old',
  });
  const firstClaim = await firstQueue.claimNext();

  await repository.transitionGeneration({
    generationId: generation.id,
    to: 'submitted',
    claimToken: firstClaim.leaseToken,
  });
  await repository.transitionGeneration({
    generationId: generation.id,
    to: 'provider_processing',
    claimToken: firstClaim.leaseToken,
  });
  await repository.transitionGeneration({
    generationId: generation.id,
    to: 'verifying',
    claimToken: firstClaim.leaseToken,
  });
  await repository.addCandidate({
    generationId: generation.id,
    candidateId: 'candidate_abandoned',
    assetId: 'asset_abandoned',
    claimToken: firstClaim.leaseToken,
  });

  const recoveryQueue = new PostgresGenerationQueue({
    pool,
    repository,
    now: () => '2026-08-19T06:40:02.000Z',
    leaseDurationMs: 1_000,
    tokenFactory: () => 'lease_new',
  });
  const recovered = await recoveryQueue.claimNext();

  assert.equal(recovered.id, generation.id);
  assert.equal(recovered.status, 'preparing');
  assert.equal(recovered.leaseToken, 'lease_new');
  assert.equal(recovered.attemptCount, 2);
  assert.equal(recovered.candidates.length, 0);

  await assert.rejects(
    repository.transitionGeneration({
      generationId: generation.id,
      to: 'submitted',
      claimToken: firstClaim.leaseToken,
    }),
    GenerationLeaseLostError,
  );
  await assert.rejects(
    repository.addCandidate({
      generationId: generation.id,
      candidateId: 'candidate_stale',
      assetId: 'asset_stale',
      claimToken: firstClaim.leaseToken,
    }),
    GenerationLeaseLostError,
  );
  assert.equal('leaseToken' in (await repository.getGeneration(generation.id)), false);

  const submitted = await repository.transitionGeneration({
    generationId: generation.id,
    to: 'submitted',
    claimToken: recovered.leaseToken,
  });
  assert.equal(submitted.status, 'submitted');
});

test('renews a lease so another worker cannot reclaim it early', async () => {
  const repository = createRepository();
  const project = await createProject(repository);
  const generation = await repository.requestGeneration({
    projectId: project.id,
    baseRevisionId: project.activeRevisionId,
    idempotencyKey: 'lease-renew',
    patch: editPatch(),
  });
  let now = '2026-08-19T06:40:00.000Z';
  const queue = new PostgresGenerationQueue({
    pool,
    repository,
    now: () => now,
    leaseDurationMs: 1_000,
    tokenFactory: () => 'lease_renewed',
  });
  const claimed = await queue.claimNext();

  now = '2026-08-19T06:40:00.500Z';
  const renewed = await queue.renewLease({
    generationId: generation.id,
    claimToken: claimed.leaseToken,
  });
  assert.equal(renewed.leaseExpiresAt, '2026-08-19T06:40:01.500Z');

  const earlyQueue = new PostgresGenerationQueue({
    pool,
    repository,
    now: () => '2026-08-19T06:40:01.200Z',
    leaseDurationMs: 1_000,
    tokenFactory: () => 'lease_too_early',
  });
  assert.equal(await earlyQueue.claimNext(), null);

  const lateQueue = new PostgresGenerationQueue({
    pool,
    repository,
    now: () => '2026-08-19T06:40:01.600Z',
    leaseDurationMs: 1_000,
    tokenFactory: () => 'lease_after_expiry',
  });
  const reclaimed = await lateQueue.claimNext();
  assert.equal(reclaimed.leaseToken, 'lease_after_expiry');
  assert.equal(reclaimed.attemptCount, 2);
});

test('fails an expired generation after max attempts and releases the project lock', async () => {
  const repository = createRepository();
  const project = await createProject(repository);
  const generation = await repository.requestGeneration({
    projectId: project.id,
    baseRevisionId: project.activeRevisionId,
    idempotencyKey: 'lease-exhausted',
    patch: editPatch(),
  });

  const firstQueue = new PostgresGenerationQueue({
    pool,
    repository,
    now: () => '2026-08-19T06:40:00.000Z',
    leaseDurationMs: 1_000,
    maxAttempts: 2,
    tokenFactory: () => 'lease_attempt_1',
  });
  await firstQueue.claimNext();

  const secondQueue = new PostgresGenerationQueue({
    pool,
    repository,
    now: () => '2026-08-19T06:40:02.000Z',
    leaseDurationMs: 1_000,
    maxAttempts: 2,
    tokenFactory: () => 'lease_attempt_2',
  });
  await secondQueue.claimNext();

  const exhaustedQueue = new PostgresGenerationQueue({
    pool,
    repository,
    now: () => '2026-08-19T06:40:04.000Z',
    leaseDurationMs: 1_000,
    maxAttempts: 2,
    tokenFactory: () => 'lease_attempt_3',
  });
  assert.equal(await exhaustedQueue.claimNext(), null);

  const failed = await repository.getGeneration(generation.id);
  const updatedProject = await repository.getProject(project.id);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.error, {
    message: 'Generation lease exhausted after 2 attempts',
  });
  assert.equal(updatedProject.runningGenerationId, null);
});

test('migration adds persisted provider job fields', async () => {
  const result = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'generation_jobs'
      AND column_name IN (
        'provider_name',
        'provider_job_id',
        'provider_submitted_at'
      )
    ORDER BY column_name
  `);

  assert.deepEqual(
    result.rows.map((row) => row.column_name),
    ['provider_job_id', 'provider_name', 'provider_submitted_at'],
  );
});

test('migration adds persisted provider model identity', async () => {
  const result = await pool.query(`
    SELECT column_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'generation_jobs'
      AND column_name = 'provider_model'
  `);

  assert.deepEqual(result.rows, [
    { column_name: 'provider_model', is_nullable: 'YES' },
  ]);
});

test('provider job binding is idempotent and cannot be replaced', async () => {
  const repository = createRepository();
  const project = await createProject(repository);
  const generation = await repository.requestGeneration({
    projectId: project.id,
    baseRevisionId: project.activeRevisionId,
    idempotencyKey: 'provider-binding',
    patch: editPatch(),
  });
  const queue = new PostgresGenerationQueue({
    pool,
    repository,
    tokenFactory: () => 'lease_provider_binding',
  });
  const claimed = await queue.claimNext();
  await repository.transitionGeneration({
    generationId: generation.id,
    to: 'submitted',
    claimToken: claimed.leaseToken,
  });

  const first = await repository.recordProviderJob({
    generationId: generation.id,
    claimToken: claimed.leaseToken,
    providerName: 'mock',
    providerModel: 'mock-image-v1',
    providerJobId: 'provider_job_fixed',
  });
  const repeated = await repository.recordProviderJob({
    generationId: generation.id,
    claimToken: claimed.leaseToken,
    providerName: 'mock',
    providerModel: 'mock-image-v1',
    providerJobId: 'provider_job_fixed',
  });

  assert.equal(first.providerModel, 'mock-image-v1');
  assert.deepEqual(repeated, first);
  await assert.rejects(
    repository.recordProviderJob({
      generationId: generation.id,
      claimToken: claimed.leaseToken,
      providerName: 'mock',
      providerModel: 'mock-image-v1',
      providerJobId: 'provider_job_replacement',
    }),
    ProviderJobConflictError,
  );
  await assert.rejects(
    repository.recordProviderJob({
      generationId: generation.id,
      claimToken: claimed.leaseToken,
      providerName: 'mock',
      providerModel: 'mock-image-v2',
      providerJobId: 'provider_job_fixed',
    }),
    ProviderJobConflictError,
  );
  await assert.rejects(
    repository.recordProviderJob({
      generationId: generation.id,
      claimToken: claimed.leaseToken,
      providerName: 'mock',
      providerModel: '',
      providerJobId: 'provider_job_missing_model',
    }),
    /requires a non-empty provider model/,
  );
});

test('reclaimed worker resumes the persisted provider job without duplicate submission', async () => {
  const repository = createRepository();
  const project = await createProject(repository);
  const generation = await repository.requestGeneration({
    projectId: project.id,
    baseRevisionId: project.activeRevisionId,
    idempotencyKey: 'provider-resume',
    patch: editPatch(),
  });
  const firstQueue = new PostgresGenerationQueue({
    pool,
    repository,
    now: () => '2026-08-19T06:40:00.000Z',
    leaseDurationMs: 1_000,
    tokenFactory: () => 'lease_provider_old',
  });
  const firstClaim = await firstQueue.claimNext();
  await repository.transitionGeneration({
    generationId: generation.id,
    to: 'submitted',
    claimToken: firstClaim.leaseToken,
  });
  await repository.recordProviderJob({
    generationId: generation.id,
    claimToken: firstClaim.leaseToken,
    providerName: 'mock',
    providerModel: 'mock-image-v1',
    providerJobId: 'provider_job_existing',
  });
  await repository.transitionGeneration({
    generationId: generation.id,
    to: 'provider_processing',
    claimToken: firstClaim.leaseToken,
  });

  const providerCalls = [];
  const recoveryQueue = new PostgresGenerationQueue({
    pool,
    repository,
    now: () => '2026-08-19T06:40:02.000Z',
    leaseDurationMs: 1_000,
    tokenFactory: () => 'lease_provider_new',
  });
  const worker = new GenerationWorker({
    queue: {
      async claimNext() {
        const reclaimed = await recoveryQueue.claimNext();
        assert.equal(reclaimed.providerModel, 'mock-image-v1');
        return reclaimed;
      },
    },
    repository,
    provider: {
      capability: 'image_generation',
      providerName: 'mock',
      modelName: 'mock-image-v1',
      async submit() {
        providerCalls.push('submit');
        throw new Error('must not submit an existing provider job');
      },
      async waitForResult({ jobId }) {
        providerCalls.push(['waitForResult', jobId]);
        return [
          {
            candidateId: 'candidate_provider_resumed',
            assetId: 'asset_provider_resumed',
          },
        ];
      },
    },
    heartbeatIntervalMs: 0,
  });

  const completed = await worker.runOnce();
  const publicGeneration = await repository.getGeneration(generation.id);

  assert.equal(completed.status, 'completed');
  assert.deepEqual(providerCalls, [
    ['waitForResult', 'provider_job_existing'],
  ]);
  assert.equal('providerJobId' in publicGeneration, false);
  assert.equal('providerModel' in publicGeneration, false);
});

test('reclaimed worker resumes a legacy provider job without model identity', async () => {
  const repository = createRepository();
  const project = await createProject(repository);
  const generation = await repository.requestGeneration({
    projectId: project.id,
    baseRevisionId: project.activeRevisionId,
    idempotencyKey: 'legacy-provider-resume',
    patch: editPatch(),
  });
  const firstQueue = new PostgresGenerationQueue({
    pool,
    repository,
    now: () => '2026-08-19T06:40:00.000Z',
    leaseDurationMs: 1_000,
    tokenFactory: () => 'lease_legacy_provider_old',
  });
  const firstClaim = await firstQueue.claimNext();
  await repository.transitionGeneration({
    generationId: generation.id,
    to: 'submitted',
    claimToken: firstClaim.leaseToken,
  });
  await pool.query(
    `UPDATE generation_jobs
     SET provider_name = 'mock',
         provider_job_id = 'legacy_provider_job',
         provider_submitted_at = $2
     WHERE id = $1`,
    [generation.id, '2026-08-19T06:40:00.000Z'],
  );
  await repository.transitionGeneration({
    generationId: generation.id,
    to: 'provider_processing',
    claimToken: firstClaim.leaseToken,
  });

  let submitCalls = 0;
  const waitCalls = [];
  const recoveryQueue = new PostgresGenerationQueue({
    pool,
    repository,
    now: () => '2026-08-19T06:40:02.000Z',
    leaseDurationMs: 1_000,
    tokenFactory: () => 'lease_legacy_provider_new',
  });
  const worker = new GenerationWorker({
    queue: {
      async claimNext() {
        const reclaimed = await recoveryQueue.claimNext();
        assert.equal(reclaimed.providerModel, null);
        return reclaimed;
      },
    },
    repository,
    provider: {
      capability: 'image_generation',
      providerName: 'mock',
      modelName: 'mock-image-v1',
      async submit() {
        submitCalls += 1;
        throw new Error('must not submit a legacy provider job');
      },
      async waitForResult({ jobId }) {
        waitCalls.push(jobId);
        return [
          {
            candidateId: 'candidate_legacy_provider_resumed',
            assetId: 'asset_legacy_provider_resumed',
          },
        ];
      },
    },
    heartbeatIntervalMs: 0,
  });

  const completed = await worker.runOnce();

  assert.equal(completed.status, 'completed');
  assert.equal(submitCalls, 0);
  assert.deepEqual(waitCalls, ['legacy_provider_job']);
});

test('edit interpreter creates a persisted generation from a language model patch', async () => {
  const repository = createRepository();
  const project = await createProject(repository);
  let modelInput;
  const interpreter = new EditInterpreter({
    repository,
    languageModel: new MockLanguageModel({
      planner: async (input) => {
        modelInput = input;
        return editPatch('white linen coat');
      },
    }),
  });

  const generation = await interpreter.interpretAndRequestGeneration({
    projectId: project.id,
    baseRevisionId: project.activeRevisionId,
    idempotencyKey: 'language-edit-1',
    message: '换成白色亚麻外套，保持人物和背景',
  });
  const persisted = await repository.getGeneration(generation.id);

  assert.equal(generation.status, 'queued');
  assert.equal(modelInput.message, '换成白色亚麻外套，保持人物和背景');
  assert.deepEqual(modelInput.photoState, initialState());
  assert.deepEqual(persisted.patch, editPatch('white linen coat'));
  assert.equal(persisted.proposedState.appearance.outfit, 'white linen coat');
  assert.deepEqual(persisted.proposedState.constraints, [
    { path: 'subject.identity', strength: 'hard', source: 'user' },
    { path: 'scene.background', strength: 'hard', source: 'user' },
  ]);
});

test('edit interpreter does not persist or lock a generation for an invalid model patch', async () => {
  const repository = createRepository();
  const project = await createProject(repository);
  const interpreter = new EditInterpreter({
    repository,
    languageModel: new MockLanguageModel({
      planner: async () => ({
        modify: [
          {
            path: 'account.balance',
            operation: 'replace',
            value: 0,
          },
        ],
        preserve: [],
      }),
    }),
  });

  await assert.rejects(
    interpreter.interpretAndRequestGeneration({
      projectId: project.id,
      baseRevisionId: project.activeRevisionId,
      idempotencyKey: 'language-edit-invalid',
      message: '执行非法修改',
    }),
    EditInterpretationFailedError,
  );

  const generationCount = await pool.query(
    'SELECT count(*)::int AS count FROM generation_jobs',
  );
  const persistedProject = await repository.getProject(project.id);
  assert.equal(generationCount.rows[0].count, 0);
  assert.equal(persistedProject.runningGenerationId, null);
});

test('edit interpreter preserves revision conflict when state changes during planning', async () => {
  const repository = createRepository();
  const project = await createProject(repository);
  const interpreter = new EditInterpreter({
    repository,
    languageModel: new MockLanguageModel({
      planner: async () => {
        await pool.query(
          `INSERT INTO photo_revisions
            (id, project_id, parent_revision_id, state_json, anchor_asset_id,
             source_generation_id, created_at)
           VALUES ($1, $2, $3, $4, $5, NULL, $6)`,
          [
            'revision_concurrent',
            project.id,
            project.activeRevisionId,
            {
              ...initialState(),
              appearance: { outfit: 'concurrent coat' },
            },
            'asset_source',
            '2026-08-19T06:41:00.000Z',
          ],
        );
        await pool.query(
          `UPDATE projects
           SET active_revision_id = $2, updated_at = $3
           WHERE id = $1`,
          [
            project.id,
            'revision_concurrent',
            '2026-08-19T06:41:00.000Z',
          ],
        );
        return editPatch('planned coat');
      },
    }),
  });

  await assert.rejects(
    interpreter.interpretAndRequestGeneration({
      projectId: project.id,
      baseRevisionId: project.activeRevisionId,
      idempotencyKey: 'language-edit-stale',
      message: '换一件新外套',
    }),
    RevisionConflictError,
  );

  const generationCount = await pool.query(
    'SELECT count(*)::int AS count FROM generation_jobs',
  );
  assert.equal(generationCount.rows[0].count, 0);
});
