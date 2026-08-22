import { appendEntry, readEntry } from './entries.mjs';
import { isUniqueViolation, sessionError } from './errors.mjs';
import { computeStats, getFact, setFact } from './facts.mjs';
import { createLane, moveLane, readLanes, validateTarget } from './lanes.mjs';
import { findEntries, findEntriesOnBranch, getLog } from './queries.mjs';
import { appendRecord, findOpenOperations, findRecords } from './records.mjs';
import { readSession } from './sessions.mjs';

function translate(error) {
  if (error?.name === 'SessionError') return error;
  if (isUniqueViolation(error)) {
    return sessionError('already_exists', error.message, error);
  }
  if (error instanceof TypeError) {
    return sessionError('invalid_payload', error.message, error);
  }
  return sessionError('storage', error?.message ?? String(error), error);
}

export function createPostgresSessionStorage({ pool, sessionId }) {
  if (!pool) throw new TypeError('createPostgresSessionStorage requires a pg pool');
  if (!sessionId) {
    throw new TypeError('createPostgresSessionStorage requires a sessionId');
  }

  /** 每个 mutation 一个事务：seq 分配与写入必须原子，否则并发下会重号。 */
  async function inTransaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw translate(error);
    } finally {
      client.release();
    }
  }

  async function withClient(fn) {
    const client = await pool.connect();
    try {
      return await fn(client);
    } catch (error) {
      throw translate(error);
    } finally {
      client.release();
    }
  }

  return {
    async getMetadata() {
      const row = await withClient((client) => readSession(client, sessionId));
      if (!row) throw sessionError('not_found', `Session ${sessionId} not found`);
      return {
        id: row.id,
        createdAt: row.createdAt,
        parentSessionId: row.parentSessionId ?? undefined,
        ...row.metadata,
      };
    },

    getLanes: () => withClient((client) => readLanes(client, sessionId)),
    createLane: (lane, at) =>
      inTransaction((client) => createLane(client, sessionId, lane, at)),
    moveLane: (lane, to) =>
      inTransaction((client) => moveLane(client, sessionId, lane, to)),

    appendEntry: (entry, lane) =>
      inTransaction((client) => appendEntry(client, sessionId, entry, lane)),
    appendRecord: (record) =>
      inTransaction((client) => appendRecord(client, sessionId, record)),

    getEntry: (id) => withClient((client) => readEntry(client, sessionId, id)),
    findEntries: (query) =>
      withClient((client) => findEntries(client, sessionId, query)),
    findEntriesOnBranch: (query) =>
      withClient((client) => findEntriesOnBranch(client, sessionId, query)),
    findRecords: (query) =>
      withClient((client) => findRecords(client, sessionId, query)),
    findOpenOperations: (lane, options) =>
      withClient((client) => findOpenOperations(client, sessionId, lane, options)),
    getLog: (options) => withClient((client) => getLog(client, sessionId, options)),

    getName: () => withClient((client) => getFact(client, sessionId, 'name', null)),
    setName: (name) =>
      inTransaction((client) => setFact(client, sessionId, 'name', null, name)),
    getLabel: (id) => withClient((client) => getFact(client, sessionId, 'label', id)),
    setLabel: (id, label) =>
      inTransaction(async (client) => {
        // label 的目标必须是已存在的 entry
        await validateTarget(client, sessionId, id);
        await setFact(client, sessionId, 'label', id, label);
      }),

    getStats: () => withClient((client) => computeStats(client, sessionId)),
  };
}
