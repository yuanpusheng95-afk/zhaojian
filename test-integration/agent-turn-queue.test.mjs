import assert from 'node:assert/strict';
import { beforeEach, describe, expect, test } from 'bun:test';

import pg from 'pg';

import {
  IdempotencyConflictError,
  ProjectBusyError,
  TurnLeaseLostError,
  createAgentTurnQueue,
} from '../src/infrastructure/postgres/agent-turn-queue.js';
import { runMigrations } from '../src/infrastructure/postgres/migrate.js';

const { Pool } = pg;
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    'postgres://photo_agent:photo_agent@127.0.0.1:54329/photo_agent_test',
});
const queue = createAgentTurnQueue({ pool, leaseMs: 30_000 });

beforeEach(async () => {
  const database = await pool.query('SELECT current_database() AS name');
  if (!database.rows[0].name.endsWith('_test')) {
    throw new Error(`Refusing to reset non-test database: ${database.rows[0].name}`);
  }
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations(pool);
});



async function createProject(projectId = 'project_1') {
  await pool.query(
    `INSERT INTO projects (id, name, owner_id, created_at, updated_at)
     VALUES ($1, 'Test', 'dev', now(), now())`,
    [projectId],
  );
}

test('requestTurn creates a queued turn and occupies the project lock', async () => {
  await createProject();
  const result = await queue.requestTurn({
    projectId: 'project_1',
    userMessage: 'make it seaside',
    idempotencyKey: 'key_1',
  });
  const project = (await pool.query('SELECT * FROM projects WHERE id = $1', ['project_1'])).rows[0];
  const turn = (await pool.query('SELECT * FROM agent_turns WHERE id = $1', [result.turnId])).rows[0];

  assert.equal(result.replayed, false);
  assert.equal(turn.status, 'queued');
  assert.equal(project.running_turn_id, result.turnId);
});

test('requestTurn replays the same key and message without taking a second lock', async () => {
  await createProject();
  const first = await queue.requestTurn({ projectId: 'project_1', userMessage: 'same', idempotencyKey: 'key_1' });
  const second = await queue.requestTurn({ projectId: 'project_1', userMessage: 'same', idempotencyKey: 'key_1' });
  const count = await pool.query('SELECT count(*)::int AS count FROM agent_turns');

  assert.equal(second.replayed, true);
  assert.equal(second.turnId, first.turnId);
  assert.equal(count.rows[0].count, 1);
});

test('requestTurn rejects the same key with a different message as idempotency conflict', async () => {
  await createProject();
  await queue.requestTurn({ projectId: 'project_1', userMessage: 'first', idempotencyKey: 'key_1' });
  await assert.rejects(
    queue.requestTurn({ projectId: 'project_1', userMessage: 'second', idempotencyKey: 'key_1' }),
    IdempotencyConflictError,
  );
});

test('requestTurn rejects a busy project', async () => {
  await createProject();
  await queue.requestTurn({ projectId: 'project_1', userMessage: 'first', idempotencyKey: 'key_1' });
  await assert.rejects(
    queue.requestTurn({ projectId: 'project_1', userMessage: 'second', idempotencyKey: 'key_2' }),
    ProjectBusyError,
  );
});

test('claimNextTurn moves a queued turn to running with a lease', async () => {
  await createProject();
  const requested = await queue.requestTurn({ projectId: 'project_1', userMessage: 'work', idempotencyKey: 'key_1' });
  const claimed = await queue.claimNextTurn();
  const turn = (await pool.query('SELECT * FROM agent_turns WHERE id = $1', [claimed.turnId])).rows[0];

  assert.equal(claimed.turnId, requested.turnId);
  assert.equal(claimed.projectId, 'project_1');
  assert.equal(claimed.userMessage, 'work');
  assert.match(turn.lease_token, /^[\da-f-]{36}$/);
  assert.equal(turn.status, 'running');
  assert.ok(turn.lease_expires_at > new Date());
  assert.equal(await queue.claimNextTurn(), null);
});

test('claims two projects independently under SKIP LOCKED ordering', async () => {
  await createProject('project_1');
  await createProject('project_2');
  await queue.requestTurn({ projectId: 'project_1', userMessage: 'one', idempotencyKey: 'key_1' });
  await queue.requestTurn({ projectId: 'project_2', userMessage: 'two', idempotencyKey: 'key_2' });

  const first = await queue.claimNextTurn();
  const second = await queue.claimNextTurn();

  assert.notEqual(first.projectId, second.projectId);
  assert.ok(await queue.claimNextTurn() === null);
});

test('failExpiredTurns fails stale work and releases the lock without retry', async () => {
  await createProject();
  const requested = await queue.requestTurn({ projectId: 'project_1', userMessage: 'stale', idempotencyKey: 'key_1' });
  await queue.claimNextTurn();
  await pool.query(
    `UPDATE agent_turns SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
    [requested.turnId],
  );

  const failed = await queue.failExpiredTurns();
  const turn = (await pool.query('SELECT * FROM agent_turns WHERE id = $1', [requested.turnId])).rows[0];
  const project = (await pool.query('SELECT running_turn_id FROM projects WHERE id = $1', ['project_1'])).rows[0];

  assert.equal(failed, 1);
  assert.equal(turn.status, 'failed');
  assert.equal(turn.error_json.code, 'WORKER_LEASE_EXPIRED');
  assert.equal(project.running_turn_id, null);
  assert.equal(await queue.claimNextTurn(), null);
});

test('renewTurnLease extends a live lease and rejects a lost token', async () => {
  await createProject();
  const requested = await queue.requestTurn({ projectId: 'project_1', userMessage: 'renew', idempotencyKey: 'key_1' });
  const claimed = await queue.claimNextTurn();

  await queue.renewTurnLease({ turnId: claimed.turnId, leaseToken: claimed.leaseToken });
  const renewed = (await pool.query('SELECT lease_expires_at FROM agent_turns WHERE id = $1', [claimed.turnId])).rows[0];
  assert.ok(renewed.lease_expires_at > new Date());

  await assert.rejects(
    queue.renewTurnLease({ turnId: claimed.turnId, leaseToken: 'wrong-token' }),
    TurnLeaseLostError,
  );
  assert.equal(requested.turnId, claimed.turnId);
});

test('finishTurn writes outcome, releases the lock, and is idempotent for the same state', async () => {
  await createProject();
  await queue.requestTurn({ projectId: 'project_1', userMessage: 'finish', idempotencyKey: 'key_1' });
  const claimed = await queue.claimNextTurn();

  await queue.finishTurn({
    turnId: claimed.turnId,
    leaseToken: claimed.leaseToken,
    status: 'completed',
    outcome: { revisionId: 'revision_2' },
  });
  await queue.finishTurn({
    turnId: claimed.turnId,
    leaseToken: claimed.leaseToken,
    status: 'completed',
    outcome: { revisionId: 'revision_2' },
  });

  const turn = (await pool.query('SELECT * FROM agent_turns WHERE id = $1', [claimed.turnId])).rows[0];
  const project = (await pool.query('SELECT running_turn_id FROM projects WHERE id = $1', ['project_1'])).rows[0];
  assert.equal(turn.status, 'completed');
  assert.deepEqual(turn.outcome_json, { revisionId: 'revision_2' });
  assert.equal(project.running_turn_id, null);
});

test('finishTurn rejects a wrong token without changing state', async () => {
  await createProject();
  await queue.requestTurn({ projectId: 'project_1', userMessage: 'lost', idempotencyKey: 'key_1' });
  const claimed = await queue.claimNextTurn();

  await assert.rejects(
    queue.finishTurn({ turnId: claimed.turnId, leaseToken: 'wrong-token', status: 'completed' }),
    TurnLeaseLostError,
  );
  const turn = (await pool.query('SELECT status FROM agent_turns WHERE id = $1', [claimed.turnId])).rows[0];
  assert.equal(turn.status, 'running');
});

test('concurrent requestTurn with the same key replays the same turn instead of PROJECT_BUSY', async () => {
  await createProject();
  const request = () =>
    queue.requestTurn({ projectId: 'project_1', userMessage: 'warm it up', idempotencyKey: 'race-1' });

  const [first, second] = await Promise.all([request(), request()]);
  assert.equal(first.turnId, second.turnId);
  const replays = [first.replayed, second.replayed].filter(Boolean).length;
  assert.equal(replays, 1, 'exactly one of the two concurrent requests should be a replay');

  const lock = await pool.query('SELECT running_turn_id FROM projects WHERE id = $1', ['project_1']);
  assert.equal(lock.rows[0].running_turn_id, first.turnId);
});
