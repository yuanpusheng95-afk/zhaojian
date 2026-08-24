import { appendEntry, readEntry } from './entries.js';
import { isUniqueViolation, sessionError } from './errors.js';
import { computeStats, getFact, setFact } from './facts.js';
import { createLane, moveLane, readLanes, validateTarget } from './lanes.js';
import { findEntries, findEntriesOnBranch, getLog } from './queries.js';
import { appendRecord, findOpenOperations, findRecords } from './records.js';
import { readSession } from './sessions.js';
import type { Pool, PoolClient } from 'pg';

function translate(error: unknown) {
  if ((error as any)?.name === 'SessionError') return error;
  if (isUniqueViolation(error)) {
    return sessionError('already_exists', (error as Error).message, error);
  }
  if (error instanceof TypeError) {
    return sessionError('invalid_payload', error.message, error);
  }
  return sessionError('storage', (error as Error)?.message ?? String(error), error);
}

export function createPostgresSessionStorage({ pool, sessionId }: { pool: Pool; sessionId: string }) {
  if (!pool) throw new TypeError('createPostgresSessionStorage requires a pg pool');
  if (!sessionId) {
    throw new TypeError('createPostgresSessionStorage requires a sessionId');
  }

  /** 每个 mutation 一个事务：seq 分配与写入必须原子，否则并发下会重号。 */
  async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
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

  async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
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
    createLane: (lane: string, at?: string | null) =>
      inTransaction((client) => createLane(client, sessionId, lane, at)),
    moveLane: (lane: string, to?: string | null) =>
      inTransaction((client) => moveLane(client, sessionId, lane, to)),

    appendEntry: (entry: any, lane: string) =>
      inTransaction((client) => appendEntry(client, sessionId, entry, lane)),
    appendRecord: (record: any) =>
      inTransaction((client) => appendRecord(client, sessionId, record)),

    getEntry: (id: string) => withClient((client) => readEntry(client, sessionId, id)),
    findEntries: (query?: any) =>
      withClient((client) => findEntries(client, sessionId, query)),
    findEntriesOnBranch: (query?: any) =>
      withClient((client) => findEntriesOnBranch(client, sessionId, query)),
    findRecords: (query?: any) =>
      withClient((client) => findRecords(client, sessionId, query)),
    findOpenOperations: (lane: string, options?: any) =>
      withClient((client) => findOpenOperations(client, sessionId, lane, options)),
    getLog: (options?: { afterSeq?: number; limit?: number }) => withClient((client) => getLog(client, sessionId, options)),

    getName: () => withClient((client) => getFact(client, sessionId, 'name', null)),
    setName: (name: unknown) =>
      inTransaction((client) => setFact(client, sessionId, 'name', null, name)),
    getLabel: (id: string) => withClient((client) => getFact(client, sessionId, 'label', id)),
    setLabel: (id: string, label: unknown) =>
      inTransaction(async (client) => {
        // label 的目标必须是已存在的 entry
        await validateTarget(client, sessionId, id);
        await setFact(client, sessionId, 'label', id, label);
      }),

    getStats: () => withClient((client) => computeStats(client, sessionId)),
  };
}
