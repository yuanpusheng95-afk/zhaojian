import assert from 'node:assert/strict';
import { describe, expect, test } from 'bun:test';

import pg from 'pg';

import { runMigrations } from '../src/infrastructure/postgres/migrate.js';
import { createPostgresSessionRepo } from '../src/infrastructure/postgres/session/repo.js';
import { createPostgresSessionStorage } from '../src/infrastructure/postgres/session/storage.js';

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
    throw new Error(`Refusing to reset non-test database: ${database.rows[0].name}`);
  }
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations(pool);
}

async function withRepo(fn) {
  await resetDatabase();
  return fn(createPostgresSessionRepo({ pool }));
}

function messageEntry(id, text) {
  return {
    type: 'message',
    id,
    message: { role: 'user', content: [{ type: 'text', text }], timestamp: 1 },
  };
}

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

test('create returns a Session and list reports it', async () => {
  await withRepo(async (repo) => {
    const session = await repo.create({ id: 'session-1' });
    assert.equal(typeof session.appendEntry, 'function');
    assert.deepEqual((await repo.list()).map((metadata) => metadata.id), ['session-1']);
  });
});

test('one shared sequence advances across entries and lane creation', async () => {
  await withRepo(async (repo) => {
    const session = await repo.create({ id: 's1' });
    const root = await session.appendEntry(messageEntry('root', 'root'), 'main');
    await session.createLane('thread', root.id);
    const child = await session.appendEntry(messageEntry('child', 'child'), 'thread');

    assert.equal(root.seq, 1);
    assert.equal(child.seq, 3, 'createLane must consume seq 2');
  });
});

test('appendEntry assigns parentId from the lane leaf and advances it', async () => {
  await withRepo(async (repo) => {
    const session = await repo.create({ id: 's1' });
    const root = await session.appendEntry(messageEntry('root', 'a'), 'main');
    const second = await session.appendEntry(messageEntry('second', 'b'), 'main');

    assert.equal(root.parentId, null);
    assert.equal(second.parentId, 'root');
    assert.deepEqual(await session.getLanes(), [{ lane: 'main', leafId: 'second' }]);
  });
});

test('moveLane repoints a lane without touching entries', async () => {
  await withRepo(async (repo) => {
    const session = await repo.create({ id: 's1' });
    const root = await session.appendEntry(messageEntry('root', 'a'), 'main');
    await session.appendEntry(messageEntry('second', 'b'), 'main');
    await session.moveLane('main', root.id);

    assert.deepEqual(await session.getLanes(), [{ lane: 'main', leafId: 'root' }]);
    assert.ok(await session.getEntry('second'));
  });
});

test('read entry round-trips the provisioned payload with assigned fields', async () => {
  await withRepo(async (repo) => {
    const session = await repo.create({ id: 's1' });
    await session.appendEntry(messageEntry('root', 'hello'), 'main');
    const entry = await session.getEntry('root');

    assert.equal(entry.type, 'message');
    assert.equal(entry.id, 'root');
    assert.equal(entry.seq, 1);
    assert.equal(entry.parentId, null);
    assert.equal(typeof entry.timestamp, 'number');
    assert.equal(entry.message.content[0].text, 'hello');
  });
});

test('records share the sequence and support filtered queries', async () => {
  await withRepo(async (repo) => {
    const session = await repo.create({ id: 's1' });
    await session.appendEntry(messageEntry('root', 'a'), 'main');
    await session.createLane('side', null);
    await session.appendRecord(startedRecord('a', 'main'));
    await session.appendRecord(startedRecord('b', 'side'));
    await session.appendRecord(finishedRecord('c', 'main', 'a'));

    const record = await session.getEntry('root');
    assert.equal(record.seq, 1);

    const started = await session.findRecords({ type: 'operation_started' });
    assert.deepEqual(started.map((row) => row.id), ['b', 'a']);
    const oldestFirst = await session.findRecords({
      type: 'operation_started',
      order: 'oldestFirst',
    });
    assert.deepEqual(oldestFirst.map((row) => row.id), ['a', 'b']);
    const mainOnly = await session.findRecords({ lane: 'main', order: 'oldestFirst' });
    assert.deepEqual(mainOnly.map((row) => row.id), ['a', 'c']);
  });
});

test('open operations are newest first and reject concurrent runs', async () => {
  await withRepo(async (repo) => {
    const session = await repo.create({ id: 's1' });
    await session.appendRecord(startedRecord('run-1', 'main'));
    await session.appendRecord(finishedRecord('fin-1', 'main', 'run-1'));
    await session.appendRecord(startedRecord('run-2', 'main'));

    const open = await session.findOpenOperations('main', { limit: 2 });
    assert.deepEqual(open.map((row) => row.id), ['run-2']);
    await assert.rejects(
      () => session.appendRecord(startedRecord('run-3', 'main')),
      (error) => error.code === 'storage',
    );
  });
});

test('facts are latest-wins per kind and key', async () => {
  await withRepo(async (repo) => {
    const session = await repo.create({ id: 's1' });
    await session.setName('First');
    await session.setName('Second');
    assert.equal(await session.getName(), 'Second');

    const root = await session.appendEntry(messageEntry('e1', 'one'), 'main');
    await session.setLabel(root.id, 'checkpoint');
    assert.equal(await session.getLabel(root.id), 'checkpoint');
  });
});

test('stats count messages and sum usage records', async () => {
  await withRepo(async (repo) => {
    const session = await repo.create({ id: 's1' });
    await session.appendEntry(messageEntry('u1', 'hi'), 'main');
    await session.appendEntry(messageEntry('a1', 'yo'), 'main');
    await session.appendRecord({
      type: 'usage',
      id: 'usage-1',
      lane: 'main',
      usage: {
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        totalTokens: 18,
        cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
      },
    });

    assert.deepEqual(await session.getStats(), {
      messageCount: 2,
      cachedTokens: 2,
      uncachedTokens: 11,
      totalTokens: 18,
      costTotal: 0.3,
    });
  });
});

test('entry queries honour ordering branch filters and cursors', async () => {
  await withRepo(async (repo) => {
    const session = await repo.create({ id: 's1' });
    const a = await session.appendEntry(messageEntry('a', '1'), 'main');
    await session.appendEntry(messageEntry('b', '2'), 'main');
    await session.createLane('side', a.id);
    await session.appendEntry(messageEntry('c', '3'), 'side');

    assert.deepEqual((await session.findEntries()).map((entry) => entry.id), ['c', 'b', 'a']);
    assert.deepEqual(
      (await session.findEntries({ order: 'oldestFirst' })).map((entry) => entry.id),
      ['a', 'b', 'c'],
    );
    assert.deepEqual(
      (await session.findEntriesOnBranch({ start: 'c', order: 'oldestFirst' })).map((entry) => entry.id),
      ['a', 'c'],
    );
    assert.deepEqual(
      (await session.findEntries({ cursor: { afterSeq: 1 }, order: 'oldestFirst' })).map((entry) => entry.id),
      ['b', 'c'],
      'the cursor applies to the global sequence, so it crosses lane boundaries',
    );
  });
});

test('getLog merges entries records and lane moves in one sequence', async () => {
  await withRepo(async (repo) => {
    const session = await repo.create({ id: 's1' });
    await session.appendEntry(messageEntry('a', '1'), 'main');
    await session.appendRecord(startedRecord('run-1', 'main'));
    await session.moveLane('main', 'a');

    const log = await session.getLog();
    assert.deepEqual(log.map((item) => item.seq), [1, 2, 3]);
    assert.deepEqual(log.map((item) => item.kind), ['entry', 'record', 'lane']);

    const tail = await session.getLog({ afterSeq: 1 });
    assert.deepEqual(tail.map((item) => item.seq), [2, 3]);
  });
});

test('storage exposes every method the SessionStorage contract requires', async () => {
  await withRepo(async (repo) => {
    const storage = createPostgresSessionStorage(repo, 's1');
    for (const method of [
      'getMetadata', 'getLanes', 'createLane', 'moveLane', 'appendEntry', 'appendRecord',
      'getEntry', 'findEntries', 'findEntriesOnBranch', 'findRecords', 'findOpenOperations',
      'getLog', 'getName', 'setName', 'getLabel', 'setLabel', 'getStats',
    ]) {
      assert.equal(typeof storage[method], 'function', `missing ${method}`);
    }
  });
});

test('create rejects duplicate ids and open rejects unknown sessions', async () => {
  await withRepo(async (repo) => {
    await repo.create({ id: 'dup' });
    await assert.rejects(() => repo.create({ id: 'dup' }), (error) => error.code === 'already_exists');
    await assert.rejects(() => repo.open({ id: 'missing' }), (error) => error.code === 'not_found');
  });
});

test('fork copies only the selected branch and no records', async () => {
  await withRepo(async (repo) => {
    const source = await repo.create({ id: 'src' });
    const a = await source.appendEntry(messageEntry('a', 'a'), 'main');
    await source.appendEntry(messageEntry('b', 'b'), 'main');
    await source.appendRecord(startedRecord('run-1', 'main'));

    const forked = await repo.fork({ id: 'src' }, { id: 'fork', entryId: a.id, position: 'at' });

    assert.deepEqual((await forked.findEntries()).map((entry) => entry.id), ['a']);
    assert.deepEqual(await forked.findRecords(), []);
    assert.deepEqual(
      (await source.findEntries({ order: 'oldestFirst' })).map((entry) => entry.id),
      ['a', 'b'],
    );
  });
});

test('delete removes the session and cascades its rows', async () => {
  await withRepo(async (repo) => {
    const session = await repo.create({ id: 'gone' });
    await session.appendEntry(messageEntry('a', 'a'), 'main');
    await repo.delete({ id: 'gone' });
    assert.deepEqual(await repo.list(), []);
  });
});
