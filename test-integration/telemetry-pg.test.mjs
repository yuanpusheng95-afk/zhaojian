import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';

import pg from 'pg';

import { createPgTelemetry } from '../src/infrastructure/telemetry/pg-telemetry.mjs';
import { runMigrations } from '../src/infrastructure/postgres/migrate.mjs';

const { Pool } = pg;
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    'postgres://photo_agent:photo_agent@127.0.0.1:54329/photo_agent_test',
});

beforeEach(async () => {
  const database = await pool.query('SELECT current_database() AS name');
  if (!database.rows[0].name.endsWith('_test')) {
    throw new Error(`Refusing to reset non-test database: ${database.rows[0].name}`);
  }
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations(pool);
});

after(async () => {
  await pool.end();
});

test('pg telemetry persists spans with turn and project extraction', async () => {
  await pool.query(
    `INSERT INTO projects (id, name, owner_id, created_at, updated_at) VALUES ('p1', 'T', 'dev', now(), now())`,
  );
  const turn = await pool.query(
    `INSERT INTO agent_turns (id, project_id, user_message, idempotency_key, status, created_at, updated_at)
     VALUES ('turn_1', 'p1', 'hi', 'k1', 'queued', now(), now()) RETURNING id`,
  );
  const telemetry = createPgTelemetry({ pool });

  await telemetry.startSpan(
    { name: 'pi.agent.turn', attributes: { 'pi.turn.id': turn.rows[0].id, 'pi.project.id': 'p1' } },
    async (span) => {
      span.setAttributes({ 'pi.turn.outcome': 'completed' });
      return 'ok';
    },
  );

  await telemetry.startSpan({ name: 'pi.ai.request' }, async () => {
    throw new Error('HTTP 429 rate limited');
  }).catch(() => {});

  await telemetry.drain(2_000);

  const rows = (await pool.query(
    'SELECT name, turn_id, project_id, status, attributes, error FROM agent_telemetry_spans ORDER BY id',
  )).rows;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'pi.agent.turn');
  assert.equal(rows[0].turn_id, 'turn_1');
  assert.equal(rows[0].project_id, 'p1');
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[0].attributes['pi.turn.outcome'], 'completed');
  assert.equal(rows[1].name, 'pi.ai.request');
  assert.equal(rows[1].status, 'error');
  assert.equal(rows[1].turn_id, null);
  assert.match(rows[1].error.message, /429/);
});
