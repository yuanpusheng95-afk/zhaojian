import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import pg from 'pg';

import { runMigrations } from '../src/infrastructure/postgres/migrate.mjs';
import { nextSeq } from '../src/infrastructure/postgres/session/sequences.mjs';
import {
  insertSession,
  readSession,
} from '../src/infrastructure/postgres/session/sessions.mjs';

const { Pool } = pg;

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    'postgres://photo_agent:photo_agent@127.0.0.1:54329/photo_agent_test',
});

/** 与 postgres-repository.test.mjs 同一套护栏：拒绝重置非 _test 库。 */
async function resetDatabase() {
  const database = await pool.query('SELECT current_database() AS name');
  if (!database.rows[0].name.endsWith('_test')) {
    throw new Error(
      `Refusing to reset non-test database: ${database.rows[0].name}`,
    );
  }
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations(pool);
}

/** 重置库后交出一个 client。pool 不在这里关闭。 */
async function withClient(fn) {
  await resetDatabase();
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

after(async () => {
  await pool.end();
});

test('nextSeq starts at 1 and increases by one per call', async () => {
  await withClient(async (client) => {
    await insertSession(client, {
      id: 's1',
      createdAt: 1000,
      parentSessionId: null,
      metadata: {},
    });
    assert.equal(await nextSeq(client, 's1'), 1);
    assert.equal(await nextSeq(client, 's1'), 2);
    assert.equal(await nextSeq(client, 's1'), 3);
  });
});

test('sequences are independent per session', async () => {
  await withClient(async (client) => {
    for (const id of ['s1', 's2']) {
      await insertSession(client, {
        id,
        createdAt: 1000,
        parentSessionId: null,
        metadata: {},
      });
    }
    assert.equal(await nextSeq(client, 's1'), 1);
    assert.equal(await nextSeq(client, 's2'), 1);
    assert.equal(await nextSeq(client, 's1'), 2);
  });
});

test('readSession round-trips metadata and parent', async () => {
  await withClient(async (client) => {
    await insertSession(client, {
      id: 'parent',
      createdAt: 1000,
      parentSessionId: null,
      metadata: {},
    });
    await insertSession(client, {
      id: 'child',
      createdAt: 2000,
      parentSessionId: 'parent',
      metadata: { label: 'forked' },
    });
    const row = await readSession(client, 'child');
    assert.deepEqual(row, {
      id: 'child',
      createdAt: 2000,
      parentSessionId: 'parent',
      metadata: { label: 'forked' },
    });
  });
});
