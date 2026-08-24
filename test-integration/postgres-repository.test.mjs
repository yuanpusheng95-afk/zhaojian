import assert from 'node:assert/strict';
import { beforeEach, describe, expect, test } from 'bun:test';

import pg from 'pg';

import {
  AssetNotFoundError,
  RevisionConflictError,
  TurnNotFoundError,
} from '../src/domain/photo-project-service.js';
import { runMigrations } from '../src/infrastructure/postgres/migrate.js';
import {
  buildAssetKey,
  buildAssetUri,
} from '../src/infrastructure/storage/asset-storage.js';
import { PostgresPhotoProjectRepository } from '../src/infrastructure/postgres/photo-project-repository.js';

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
    now: () => new Date('2026-08-19T06:40:00Z'),
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

/** 夹具走真实的 key/uri 工厂——它是下一个人复制粘贴的样板，手写字面量会把错误格式扩散出去。 */
const TEST_BUCKET = 'photo-agent';

function assetUri({ projectId, assetId, contentType = 'image/jpeg' }) {
  return buildAssetUri(
    TEST_BUCKET,
    buildAssetKey({ ownerId: 'dev', projectId, assetId, contentType }),
  );
}

async function createProject(repository, projectId = 'project_1') {
  const assetId = `asset_source_${projectId}`;
  return repository.createProject({
    projectId,
    name: 'Autumn portrait',
    initialState: initialState(),
    anchorAsset: {
      assetId,
      uri: assetUri({ projectId, assetId }),
      metadata: { source: 'upload', contentType: 'image/jpeg' },
    },
  });
}

async function createTurn(projectId, turnId) {
  await pool.query(
    `INSERT INTO agent_turns
     (id, project_id, user_message, idempotency_key, status, created_at, updated_at)
     VALUES ($1, $2, 'make the coat ivory', $3, 'running', now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [turnId, projectId, `${turnId}-key`],
  );
}

function completedOutcome(candidateId = 'candidate_1', projectId = 'project_1') {
  const assetId = `asset_${candidateId}`;
  return {
    kind: 'completed',
    candidate: {
      candidateId,
      assetId,
      uri: assetUri({ projectId, assetId, contentType: 'image/png' }),
      metadata: { model: 'gpt-image-2', contentType: 'image/png' },
      verification: { passed: true },
    },
  };
}

async function createCompletedGeneration(repository, {
  projectId = 'project_1',
  turnId = 'turn_1',
  generationId = 'generation_1',
  candidateId = 'candidate_1',
} = {}) {
  await createTurn(projectId, turnId);
  const generation = await repository.recordGeneration({
    projectId,
    turnId,
    baseRevisionId: 'revision_1',
    inputAssetId: `asset_source_${projectId}`,
    patch: editPatch(),
    renderPrompt: 'ivory coat, same identity',
    outcome: completedOutcome(candidateId),
  });
  assert.equal(generation.id, generationId);
  return generation;
}

test('migration creates the turn schema and key constraints', async () => {
  const tables = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `);
  assert.ok(tables.rows.map(({ table_name }) => table_name).includes('agent_turns'));
  assert.ok(!tables.rows.map(({ table_name }) => table_name).includes('generation_jobs'));
  assert.ok(!tables.rows.map(({ table_name }) => table_name).includes('idempotency_requests'));

  const turnUnique = await pool.query(`
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'agent_turns'
      AND indexdef LIKE 'CREATE UNIQUE INDEX%'
      AND indexdef LIKE '%project_id%'
      AND indexdef LIKE '%idempotency_key%'
  `);
  const statusCheck = await pool.query(`
    SELECT pg_get_constraintdef(oid) AS constraint_definition
    FROM pg_constraint
    WHERE conrelid = 'generations'::regclass
      AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%status%'
  `);
  const projectColumns = await pool.query(`
    SELECT column_name, column_default FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'projects'
  `);
  const columns = new Map(projectColumns.rows.map(({ column_name, column_default }) => [column_name, column_default]));

  assert.equal(turnUnique.rowCount, 1);
  assert.match(statusCheck.rows[0].constraint_definition, /completed/);
  assert.match(statusCheck.rows[0].constraint_definition, /failed/);
  assert.equal(columns.get('owner_id'), "'dev'::text");
  assert.ok(columns.has('running_turn_id'));
});

test('createProject writes owner and anchor asset uri and metadata', async () => {
  const repository = createRepository();
  const project = await createProject(repository);
  const revision = await repository.getRevision(project.activeRevisionId);
  const asset = await pool.query('SELECT * FROM assets WHERE id = $1', [
    'asset_source_project_1',
  ]);

  assert.equal(project.ownerId, 'dev');
  assert.equal(project.runningTurnId, null);
  assert.equal(revision.anchorAssetId, 'asset_source_project_1');
  assert.equal(
    asset.rows[0].uri,
    's3://photo-agent/users/dev/projects/project_1/asset_source_project_1.jpg',
  );
  assert.deepEqual(asset.rows[0].metadata_json, {
    source: 'upload',
    contentType: 'image/jpeg',
  });
});

test('getAsset round-trips source and generated assets', async () => {
  const repository = createRepository();
  await createProject(repository);
  await createTurn('project_1', 'turn_1');

  await repository.recordGeneration({
    projectId: 'project_1',
    turnId: 'turn_1',
    baseRevisionId: 'revision_1',
    inputAssetId: 'asset_source_project_1',
    patch: editPatch(),
    outcome: completedOutcome(),
  });

  const source = await repository.getAsset('asset_source_project_1');
  assert.deepEqual(source, {
    id: 'asset_source_project_1',
    kind: 'source',
    uri: assetUri({
      projectId: 'project_1',
      assetId: 'asset_source_project_1',
    }),
    metadata: { source: 'upload', contentType: 'image/jpeg' },
  });

  const generated = await repository.getAsset('asset_candidate_1');
  assert.deepEqual(generated, {
    id: 'asset_candidate_1',
    kind: 'generated',
    uri: assetUri({
      projectId: 'project_1',
      assetId: 'asset_candidate_1',
      contentType: 'image/png',
    }),
    metadata: { model: 'gpt-image-2', contentType: 'image/png' },
  });

  await assert.rejects(
    repository.getAsset('asset_missing'),
    AssetNotFoundError,
  );
});

test('recordGeneration records a completed generation in one transaction', async () => {
  const repository = createRepository();
  await createProject(repository);
  await createTurn('project_1', 'turn_1');

  const generation = await repository.recordGeneration({
    projectId: 'project_1',
    turnId: 'turn_1',
    baseRevisionId: 'revision_1',
    inputAssetId: 'asset_source_project_1',
    patch: editPatch(),
    renderPrompt: 'ivory coat, same identity',
    outcome: completedOutcome(),
  });
  const output = await pool.query(
    'SELECT * FROM generation_outputs WHERE generation_id = $1',
    [generation.id],
  );
  const asset = await pool.query('SELECT * FROM assets WHERE id = $1', [
    'asset_candidate_1',
  ]);

  assert.equal(generation.status, 'completed');
  assert.equal(generation.turnId, 'turn_1');
  assert.equal(generation.inputAssetId, 'asset_source_project_1');
  assert.equal(generation.renderPrompt, 'ivory coat, same identity');
  assert.equal(output.rowCount, 1);
  assert.equal(
    asset.rows[0].uri,
    's3://photo-agent/users/dev/projects/project_1/asset_candidate_1.png',
  );
  assert.deepEqual(asset.rows[0].metadata_json, {
    model: 'gpt-image-2',
    contentType: 'image/png',
  });
});

test('recordGeneration records a failed generation with error json', async () => {
  const repository = createRepository();
  await createProject(repository);
  await createTurn('project_1', 'turn_1');

  const generation = await repository.recordGeneration({
    projectId: 'project_1',
    turnId: 'turn_1',
    baseRevisionId: 'revision_1',
    inputAssetId: 'asset_source_project_1',
    patch: editPatch(),
    outcome: { kind: 'failed', error: { message: 'provider failed' } },
  });

  assert.equal(generation.status, 'failed');
  assert.deepEqual(generation.error, { message: 'provider failed' });
  assert.equal(generation.candidates.length, 0);
});

test('recordGeneration rejects a stale base revision', async () => {
  const repository = createRepository();
  await createProject(repository);
  await createTurn('project_1', 'turn_1');

  await assert.rejects(
    repository.recordGeneration({
      projectId: 'project_1',
      turnId: 'turn_1',
      baseRevisionId: 'revision_stale',
      inputAssetId: 'asset_source_project_1',
      patch: editPatch(),
      outcome: completedOutcome(),
    }),
    RevisionConflictError,
  );
});

test('recordGeneration rejects a missing or foreign turn', async () => {
  const repository = createRepository();
  await createProject(repository);
  await createProject(repository, 'project_2');
  await createTurn('project_2', 'foreign_turn');

  await assert.rejects(
    repository.recordGeneration({
      projectId: 'project_1',
      turnId: 'missing_turn',
      baseRevisionId: 'revision_1',
      inputAssetId: 'asset_source_project_1',
      patch: editPatch(),
      outcome: completedOutcome(),
    }),
    TurnNotFoundError,
  );
  await assert.rejects(
    repository.recordGeneration({
      projectId: 'project_1',
      turnId: 'foreign_turn',
      baseRevisionId: 'revision_1',
      inputAssetId: 'asset_source_project_1',
      patch: editPatch(),
      outcome: completedOutcome(),
    }),
    TurnNotFoundError,
  );
});

test('recordGeneration rejects an unknown input asset with a typed domain error', async () => {
  const repository = createRepository();
  await createProject(repository);
  await createTurn('project_1', 'turn_1');

  await assert.rejects(
    () =>
      repository.recordGeneration({
        projectId: 'project_1',
        turnId: 'turn_1',
        baseRevisionId: 'revision_1',
        inputAssetId: 'asset_does_not_exist',
        patch: editPatch(),
        outcome: completedOutcome(),
      }),
    (error) => {
      // 必须是类型化领域错误，不是裸 Error 挂 code——后者会在 API 层落到 500
      assert.equal(error.name, 'AssetNotFoundError');
      assert.equal(error.code, 'ASSET_NOT_FOUND');
      return true;
    },
  );
});

test('recordGeneration rejects an invalid patch', async () => {
  const repository = createRepository();
  await createProject(repository);
  await createTurn('project_1', 'turn_1');

  await assert.rejects(
    repository.recordGeneration({
      projectId: 'project_1',
      turnId: 'turn_1',
      baseRevisionId: 'revision_1',
      inputAssetId: 'asset_source_project_1',
      patch: { modify: [{ path: 'not.allowed', operation: 'replace', value: 1 }], preserve: [] },
      outcome: completedOutcome(),
    }),
    (error) => ['INVALID_STATE_PATCH', 'UNSAFE_STATE_PATH'].includes(error.code),
  );
});

test('recordGeneration allows identical patches twice in one turn', async () => {
  const repository = createRepository();
  await createProject(repository);
  await createTurn('project_1', 'turn_1');
  const request = {
    projectId: 'project_1',
    turnId: 'turn_1',
    baseRevisionId: 'revision_1',
    inputAssetId: 'asset_source_project_1',
    patch: editPatch(),
    outcome: completedOutcome(),
  };

  const first = await repository.recordGeneration({
    ...request,
    outcome: completedOutcome('candidate_1'),
  });
  const second = await repository.recordGeneration({
    ...request,
    outcome: completedOutcome('candidate_2'),
  });

  assert.notEqual(second.id, first.id);
  assert.equal(first.status, 'completed');
  assert.equal(second.status, 'completed');
});

test('selectCandidate switches the active revision atomically', async () => {
  const repository = createRepository();
  await createProject(repository);
  const generation = await createCompletedGeneration(repository);

  const revision = await repository.selectCandidate({
    projectId: 'project_1',
    generationId: generation.id,
    candidateId: 'candidate_1',
  });
  const project = await repository.getProject('project_1');

  assert.equal(revision.sourceGenerationId, generation.id);
  assert.equal(revision.anchorAssetId, 'asset_candidate_1');
  assert.equal(project.activeRevisionId, revision.id);
});

test('selectCandidate is idempotent for the same candidate', async () => {
  const repository = createRepository();
  await createProject(repository);
  const generation = await createCompletedGeneration(repository);

  const first = await repository.selectCandidate({
    projectId: 'project_1',
    generationId: generation.id,
    candidateId: 'candidate_1',
  });
  const second = await repository.selectCandidate({
    projectId: 'project_1',
    generationId: generation.id,
    candidateId: 'candidate_1',
  });

  assert.equal(second.id, first.id);
});

test('selectCandidate rejects a different candidate after selection', async () => {
  const repository = createRepository();
  await createProject(repository);
  const generation = await createCompletedGeneration(repository);
  await repository.selectCandidate({
    projectId: 'project_1',
    generationId: generation.id,
    candidateId: 'candidate_1',
  });

  await assert.rejects(
    repository.selectCandidate({
      projectId: 'project_1',
      generationId: generation.id,
      candidateId: 'candidate_2',
    }),
    (error) => error.code === 'CANDIDATE_SELECTION_ERROR',
  );
});

test('selectCandidate rejects a stale input revision', async () => {
  const repository = createRepository();
  await createProject(repository);
  await createTurn('project_1', 'turn_2');
  const first = await createCompletedGeneration(repository, {
    turnId: 'turn_1',
    generationId: 'generation_1',
    candidateId: 'candidate_1',
  });
  const second = await repository.recordGeneration({
    projectId: 'project_1',
    turnId: 'turn_2',
    baseRevisionId: 'revision_1',
    inputAssetId: 'asset_source_project_1',
    patch: editPatch('wool coat'),
    outcome: completedOutcome('candidate_2'),
  });
  await repository.selectCandidate({
    projectId: 'project_1',
    generationId: first.id,
    candidateId: 'candidate_1',
  });
  await assert.rejects(
    repository.selectCandidate({
      projectId: 'project_1',
      generationId: second.id,
      candidateId: 'candidate_2',
    }),
    RevisionConflictError,
  );
});

test('selectCandidate rejects cross-project generation', async () => {
  const repository = createRepository();
  await createProject(repository);
  await createProject(repository, 'project_2');
  const generation = await createCompletedGeneration(repository);

  await assert.rejects(
    repository.selectCandidate({
      projectId: 'project_2',
      generationId: generation.id,
      candidateId: 'candidate_1',
    }),
    (error) => error.code === 'CANDIDATE_SELECTION_ERROR',
  );
});

test('foreign keys reject deleting a project that still has turns', async () => {
  const repository = createRepository();
  await createProject(repository);
  await createCompletedGeneration(repository);

  await assert.rejects(
    pool.query('DELETE FROM projects WHERE id = $1', ['project_1']),
    (error) => error.code === '23503',
  );
});

test('read projections expose turn fields and omit legacy fields', async () => {
  const repository = createRepository();
  const project = await createProject(repository);
  const generation = await createCompletedGeneration(repository);
  const revision = await repository.selectCandidate({
    projectId: 'project_1',
    generationId: generation.id,
    candidateId: 'candidate_1',
  });
  const [readProject, readGeneration, revisions, generations] = await Promise.all([
    repository.getProject('project_1'),
    repository.getGeneration(generation.id),
    repository.listRevisions('project_1'),
    repository.listGenerations('project_1'),
  ]);

  assert.equal(readProject.ownerId, 'dev');
  assert.equal(readProject.runningTurnId, null);
  assert.equal(readGeneration.turnId, 'turn_1');
  assert.equal(readGeneration.inputAssetId, 'asset_source_project_1');
  assert.equal(readGeneration.renderPrompt, 'ivory coat, same identity');
  assert.equal(readGeneration.operation, undefined);
  assert.equal(readGeneration.idempotencyKey, undefined);
  assert.equal(readGeneration.leaseToken, undefined);
  assert.equal(readGeneration.providerName, undefined);
  assert.equal(revisions.at(-1).id, revision.id);
  assert.equal(generations.at(-1).id, generation.id);
});

test('listGenerationsByTurn loads only the requested turn generations', async () => {
  const repository = createRepository();
  const project = await createProject(repository);
  await createCompletedGeneration(repository, {
    projectId: project.id,
    turnId: 'turn_1',
    candidateId: 'candidate_1',
  });
  await createCompletedGeneration(repository, {
    projectId: project.id,
    turnId: 'turn_1',
    generationId: 'generation_2',
    candidateId: 'candidate_2',
  });
  await createCompletedGeneration(repository, {
    projectId: project.id,
    turnId: 'turn_2',
    generationId: 'generation_3',
    candidateId: 'candidate_3',
  });

  const generations = await repository.listGenerationsByTurn({
    projectId: project.id,
    turnId: 'turn_1',
  });

  assert.deepEqual(generations.map(({ id }) => id), ['generation_1', 'generation_2']);
  assert.ok(generations.every((generation) => generation.turnId === 'turn_1'));
  assert.deepEqual(generations.map(({ candidates }) => candidates.map(({ id }) => id)), [
    ['candidate_1'],
    ['candidate_2'],
  ]);
  assert.equal(generations.at(-1).selectedCandidateId, null);
});

test('listGenerationsByTurn rejects a foreign or missing project', async () => {
  const repository = createRepository();
  await assert.rejects(
    () => repository.listGenerationsByTurn({ projectId: 'missing', turnId: 'turn_1' }),
    (error) => error.code === 'PROJECT_NOT_FOUND',
  );
});
