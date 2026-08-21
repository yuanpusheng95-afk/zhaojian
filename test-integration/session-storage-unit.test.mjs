import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import pg from 'pg';

import { runMigrations } from '../src/infrastructure/postgres/migrate.mjs';
import {
  appendEntry,
  readEntry,
} from '../src/infrastructure/postgres/session/entries.mjs';
import {
  createLane,
  insertLane,
  moveLane,
  readLaneLeaf,
  readLanes,
} from '../src/infrastructure/postgres/session/lanes.mjs';
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

function messageEntry(id, text) {
  return {
    type: 'message',
    id,
    message: { role: 'user', content: [{ type: 'text', text }], timestamp: 1 },
  };
}

/** 镜像 repo.create()：默认 main lane 用 insertLane，不消耗 seq。 */
async function seedSession(client, id = 's1') {
  await insertSession(client, {
    id,
    createdAt: 1000,
    parentSessionId: null,
    metadata: {},
  });
  await insertLane(client, id, 'main', null);
  return id;
}

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

test('one shared sequence advances across entries and lane creation', async () => {
  await withClient(async (client) => {
    const s = await seedSession(client);
    const root = await appendEntry(client, s, messageEntry('root', 'root'), 'main');
    await createLane(client, s, 'thread', root.id);
    const child = await appendEntry(client, s, messageEntry('child', 'child'), 'thread');

    assert.equal(root.seq, 1);
    assert.equal(child.seq, 3, 'createLane must consume seq 2');
  });
});

test('appendEntry assigns parentId from the lane leaf and advances it', async () => {
  await withClient(async (client) => {
    const s = await seedSession(client);
    const root = await appendEntry(client, s, messageEntry('root', 'a'), 'main');
    assert.equal(root.parentId, null, 'first entry on an empty lane has no parent');

    const second = await appendEntry(client, s, messageEntry('second', 'b'), 'main');
    assert.equal(second.parentId, 'root');
    assert.equal(await readLaneLeaf(client, s, 'main'), 'second');
  });
});

test('a new lane inherits the entry it was created at as its leaf', async () => {
  await withClient(async (client) => {
    const s = await seedSession(client);
    const root = await appendEntry(client, s, messageEntry('root', 'a'), 'main');
    await createLane(client, s, 'thread', root.id);
    const child = await appendEntry(client, s, messageEntry('child', 'b'), 'thread');

    assert.equal(child.parentId, 'root');
    assert.equal(await readLaneLeaf(client, s, 'main'), 'root', 'main is untouched');
  });
});

test('moveLane repoints a lane without touching entries', async () => {
  await withClient(async (client) => {
    const s = await seedSession(client);
    const root = await appendEntry(client, s, messageEntry('root', 'a'), 'main');
    await appendEntry(client, s, messageEntry('second', 'b'), 'main');
    await moveLane(client, s, 'main', root.id);

    assert.equal(await readLaneLeaf(client, s, 'main'), 'root');
    assert.ok(await readEntry(client, s, 'second'), 'entry survives the move');
  });
});

test('readEntry round-trips the provisioned payload with assigned fields', async () => {
  await withClient(async (client) => {
    const s = await seedSession(client);
    await appendEntry(client, s, messageEntry('root', 'hello'), 'main');
    const entry = await readEntry(client, s, 'root');

    assert.equal(entry.type, 'message');
    assert.equal(entry.id, 'root');
    assert.equal(entry.seq, 1);
    assert.equal(entry.parentId, null);
    assert.equal(typeof entry.timestamp, 'number');
    assert.equal(entry.message.content[0].text, 'hello');
  });
});

test('readLanes reports every lane with its leaf', async () => {
  await withClient(async (client) => {
    const s = await seedSession(client);
    const root = await appendEntry(client, s, messageEntry('root', 'a'), 'main');
    await createLane(client, s, 'thread', root.id);

    const lanes = await readLanes(client, s);
    assert.deepEqual(
      [...lanes].sort((a, b) => a.lane.localeCompare(b.lane)),
      [
        { lane: 'main', leafId: 'root' },
        { lane: 'thread', leafId: 'root' },
      ],
    );
  });
});
