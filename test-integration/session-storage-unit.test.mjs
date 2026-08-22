import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import pg from 'pg';

import { runMigrations } from '../src/infrastructure/postgres/migrate.mjs';
import {
  appendEntry,
  readEntry,
} from '../src/infrastructure/postgres/session/entries.mjs';
import {
  computeStats,
  getFact,
  setFact,
} from '../src/infrastructure/postgres/session/facts.mjs';
import {
  createLane,
  insertLane,
  moveLane,
  readLaneLeaf,
  readLanes,
} from '../src/infrastructure/postgres/session/lanes.mjs';
import {
  findEntries,
  findEntriesOnBranch,
  getLog,
} from '../src/infrastructure/postgres/session/queries.mjs';
import {
  appendRecord,
  findOpenOperations,
  findRecords,
} from '../src/infrastructure/postgres/session/records.mjs';
import { nextSeq } from '../src/infrastructure/postgres/session/sequences.mjs';
import { createPostgresSessionRepo } from '../src/infrastructure/postgres/session/repo.mjs';
import { createPostgresSessionStorage } from '../src/infrastructure/postgres/session/storage.mjs';
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

function startedRecord(id, lane) {
  return {
    type: 'operation_started',
    id,
    lane,
    sourceLeafId: null,
    intent: { kind: 'run', originalPrompt: [], initialMessages: [] },
  };
}

function finishedRecord(id, lane, runId) {
  return { type: 'operation_finished', id, lane, runId, outcome: 'completed' };
}

test('appendRecord assigns seq from the shared sequence', async () => {
  await withClient(async (client) => {
    const s = await seedSession(client);
    await appendEntry(client, s, messageEntry('root', 'a'), 'main');
    const record = await appendRecord(client, s, startedRecord('run-1', 'main'));
    assert.equal(record.seq, 2, 'entry took seq 1');
    assert.equal(record.lane, 'main');
    assert.equal(typeof record.timestamp, 'number');
  });
});

test('findRecords filters by type and lane', async () => {
  await withClient(async (client) => {
    const s = await seedSession(client);
    await createLane(client, s, 'side', null);
    await appendRecord(client, s, startedRecord('a', 'main'));
    await appendRecord(client, s, startedRecord('b', 'side'));
    await appendRecord(client, s, finishedRecord('c', 'main', 'a'));

    const started = await findRecords(client, s, { type: 'operation_started' });
    assert.deepEqual(started.map((r) => r.id), ['a', 'b']);

    const mainOnly = await findRecords(client, s, { lane: 'main' });
    assert.deepEqual(mainOnly.map((r) => r.id), ['a', 'c']);
  });
});

test('findOpenOperations returns newest first and excludes finished runs', async () => {
  await withClient(async (client) => {
    const s = await seedSession(client);
    await appendRecord(client, s, startedRecord('run-1', 'main'));
    await appendRecord(client, s, startedRecord('run-2', 'main'));
    await appendRecord(client, s, finishedRecord('fin-1', 'main', 'run-1'));

    const open = await findOpenOperations(client, s, 'main', { limit: 2 });
    assert.deepEqual(open.map((r) => r.id), ['run-2']);
  });
});

test('facts are latest-wins per kind and key', async () => {
  await withClient(async (client) => {
    const s = await seedSession(client);
    await setFact(client, s, 'name', null, 'First');
    await setFact(client, s, 'name', null, 'Second');
    assert.equal(await getFact(client, s, 'name', null), 'Second');
  });
});

test('labels are keyed independently', async () => {
  await withClient(async (client) => {
    const s = await seedSession(client);
    await setFact(client, s, 'label', 'e1', 'checkpoint');
    await setFact(client, s, 'label', 'e2', 'other');
    assert.equal(await getFact(client, s, 'label', 'e1'), 'checkpoint');
    assert.equal(await getFact(client, s, 'label', 'e2'), 'other');
  });
});

test('clearing a fact stores null and reads back undefined', async () => {
  await withClient(async (client) => {
    const s = await seedSession(client);
    await setFact(client, s, 'name', null, 'Named');
    await setFact(client, s, 'name', null, undefined);
    assert.equal(await getFact(client, s, 'name', null), undefined);
  });
});

test('computeStats counts messages and sums assistant usage', async () => {
  await withClient(async (client) => {
    const s = await seedSession(client);
    await appendEntry(client, s, messageEntry('u1', 'hi'), 'main');
    await appendEntry(
      client,
      s,
      {
        type: 'message',
        id: 'a1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'yo' }],
          api: 'anthropic-messages',
          provider: 'anthropic',
          model: 'claude-sonnet-4-5',
          usage: {
            input: 10,
            output: 5,
            cacheRead: 2,
            cacheWrite: 1,
            totalTokens: 18,
            cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
          },
          stopReason: 'stop',
          timestamp: 1,
        },
      },
      'main',
    );

    const stats = await computeStats(client, s);
    assert.equal(stats.messageCount, 2);
    assert.equal(stats.totalTokens, 18);
    assert.equal(stats.costTotal, 0.3);
  });
});

test('findEntries returns every entry in sequence order', async () => {
  await withClient(async (client) => {
    const s = await seedSession(client);
    await appendEntry(client, s, messageEntry('a', '1'), 'main');
    await appendEntry(client, s, messageEntry('b', '2'), 'main');
    const entries = await findEntries(client, s, {});
    assert.deepEqual(entries.map((e) => e.id), ['a', 'b']);
  });
});

test('findEntriesOnBranch walks parent links from the start entry to the root', async () => {
  await withClient(async (client) => {
    const s = await seedSession(client);
    const a = await appendEntry(client, s, messageEntry('a', '1'), 'main');
    await appendEntry(client, s, messageEntry('b', '2'), 'main');
    await createLane(client, s, 'side', a.id);
    await appendEntry(client, s, messageEntry('c', '3'), 'side');

    const branch = await findEntriesOnBranch(client, s, { start: 'c' });
    assert.deepEqual(
      branch.map((e) => e.id),
      ['a', 'c'],
      'b is on a different branch and must be excluded',
    );
  });
});

test('findEntriesOnBranch filters by type', async () => {
  await withClient(async (client) => {
    const s = await seedSession(client);
    await appendEntry(client, s, messageEntry('a', '1'), 'main');
    await appendEntry(
      client,
      s,
      { type: 'custom', id: 'n1', customType: 'note', data: { value: 1 } },
      'main',
    );
    const notes = await findEntriesOnBranch(client, s, { start: 'n1', type: 'custom' });
    assert.deepEqual(notes.map((e) => e.id), ['n1']);
  });
});

test('getLog merges entries records and lane moves in one sequence', async () => {
  await withClient(async (client) => {
    const s = await seedSession(client);
    await appendEntry(client, s, messageEntry('a', '1'), 'main');
    await appendRecord(client, s, startedRecord('run-1', 'main'));
    await moveLane(client, s, 'main', 'a');

    const log = await getLog(client, s, {});
    assert.deepEqual(log.map((item) => item.seq), [1, 2, 3]);
    assert.deepEqual(log.map((item) => item.kind), ['entry', 'record', 'lane_move']);
  });
});

test('getLog honours the afterSeq cursor', async () => {
  await withClient(async (client) => {
    const s = await seedSession(client);
    await appendEntry(client, s, messageEntry('a', '1'), 'main');
    await appendEntry(client, s, messageEntry('b', '2'), 'main');
    const tail = await getLog(client, s, { afterSeq: 1 });
    assert.deepEqual(tail.map((item) => item.seq), [2]);
  });
});

test('storage exposes every method the SessionStorage contract requires', async () => {
  const storage = createPostgresSessionStorage({ pool, sessionId: 's1' });
  for (const method of [
    'getMetadata',
    'getLanes',
    'createLane',
    'moveLane',
    'appendEntry',
    'appendRecord',
    'getEntry',
    'findEntries',
    'findEntriesOnBranch',
    'findRecords',
    'findOpenOperations',
    'getLog',
    'getName',
    'setName',
    'getLabel',
    'setLabel',
    'getStats',
  ]) {
    assert.equal(typeof storage[method], 'function', `missing ${method}`);
  }
});

test('every mutation runs in its own transaction and shares the sequence', async () => {
  await resetDatabase();
  const client = await pool.connect();
  try {
    await insertSession(client, {
      id: 's1',
      createdAt: 1000,
      parentSessionId: null,
      metadata: {},
    });
    await insertLane(client, 's1', 'main', null);
  } finally {
    client.release();
  }

  const storage = createPostgresSessionStorage({ pool, sessionId: 's1' });
  const root = await storage.appendEntry(
    { type: 'message', id: 'root', message: { role: 'user', content: [], timestamp: 1 } },
    'main',
  );
  await storage.setName('Example');

  assert.equal(root.seq, 1, 'default lane is free, so the first entry takes seq 1');
  assert.equal(await storage.getName(), 'Example');
  assert.equal((await storage.getEntry('root')).id, 'root');
});

async function withRepo(fn) {
  await resetDatabase();
  return fn(createPostgresSessionRepo({ pool }));
}

test('create returns a Session and list reports it', async () => {
  await withRepo(async (repo) => {
    const session = await repo.create({ id: 'session-1' });
    assert.equal(typeof session.appendEntry, 'function');
    const listed = await repo.list();
    assert.deepEqual(listed.map((m) => m.id), ['session-1']);
  });
});

test('create rejects a duplicate id with already_exists', async () => {
  await withRepo(async (repo) => {
    await repo.create({ id: 'dup' });
    await assert.rejects(
      () => repo.create({ id: 'dup' }),
      (error) => error.code === 'already_exists',
    );
  });
});

test('open rejects an unknown session with not_found', async () => {
  await withRepo(async (repo) => {
    await assert.rejects(
      () => repo.open({ id: 'missing' }),
      (error) => error.code === 'not_found',
    );
  });
});

test('fork copies the branch entries and leaves the source untouched', async () => {
  await withRepo(async (repo) => {
    const source = await repo.create({ id: 'src' });
    const a = await source.appendEntry(
      { type: 'message', id: 'a', message: { role: 'user', content: [], timestamp: 1 } },
      'main',
    );
    await source.appendEntry(
      { type: 'message', id: 'b', message: { role: 'user', content: [], timestamp: 1 } },
      'main',
    );

    const forked = await repo.fork({ id: 'src' }, { id: 'fork', at: a.id });

    assert.deepEqual(
      (await forked.findEntries()).map((e) => e.id),
      ['a'],
      'fork carries only the branch up to the fork point',
    );
    assert.deepEqual(
      (await source.findEntries()).map((e) => e.id),
      ['a', 'b'],
      'source must be unchanged',
    );
  });
});

test('fork does not copy records', async () => {
  await withRepo(async (repo) => {
    const source = await repo.create({ id: 'src' });
    const a = await source.appendEntry(
      { type: 'message', id: 'a', message: { role: 'user', content: [], timestamp: 1 } },
      'main',
    );
    await source.appendRecord({
      type: 'operation_started',
      id: 'run-1',
      lane: 'main',
      sourceLeafId: null,
      intent: { kind: 'run', originalPrompt: [], initialMessages: [] },
    });

    const forked = await repo.fork({ id: 'src' }, { id: 'fork', at: a.id });
    assert.deepEqual(await forked.findRecords(), []);
  });
});

test('delete removes the session and cascades its rows', async () => {
  await withRepo(async (repo) => {
    const session = await repo.create({ id: 'gone' });
    await session.appendEntry(
      { type: 'message', id: 'a', message: { role: 'user', content: [], timestamp: 1 } },
      'main',
    );
    await repo.delete({ id: 'gone' });
    assert.deepEqual(await repo.list(), []);
  });
});
