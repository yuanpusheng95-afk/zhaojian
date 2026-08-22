import { Session } from '@earendil-works/pi-agent-core';

import { isUniqueViolation, sessionError } from './errors.mjs';
import { insertLane } from './lanes.mjs';
import { findEntriesOnBranch } from './queries.mjs';
import { SESSION_TABLES } from './schema.mjs';
import {
  deleteSession,
  insertSession,
  listSessions,
  readSession,
} from './sessions.mjs';
import { nextSeq } from './sequences.mjs';
import { createPostgresSessionStorage } from './storage.mjs';

const DEFAULT_LANE = 'main';

export function createPostgresSessionRepo({ pool }) {
  if (!pool) throw new TypeError('createPostgresSessionRepo requires a pg pool');

  async function inTransaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error?.name === 'SessionError') throw error;
      if (isUniqueViolation(error)) {
        throw sessionError('already_exists', error.message, error);
      }
      throw sessionError('storage', error?.message ?? String(error), error);
    } finally {
      client.release();
    }
  }

  function openSession(id) {
    return new Session(createPostgresSessionStorage({ pool, sessionId: id }));
  }

  async function requireSession(client, id) {
    const row = await readSession(client, id);
    if (!row) throw sessionError('not_found', `Session ${id} not found`);
    return row;
  }

  return {
    async create(options) {
      const id = options?.id;
      if (!id) throw sessionError('invalid_payload', 'create requires an id');
      await inTransaction(async (client) => {
        await insertSession(client, {
          id,
          createdAt: Date.now(),
          parentSessionId: null,
          metadata: options.metadata ?? {},
        });
        // 默认 lane 不消耗 seq：conformance 要求 create() 后第一条 entry 拿到 seq 1
        await insertLane(client, id, DEFAULT_LANE, null);
      });
      return openSession(id);
    },

    async open(metadata) {
      await inTransaction((client) => requireSession(client, metadata.id));
      return openSession(metadata.id);
    },

    async list() {
      const client = await pool.connect();
      try {
        const rows = await listSessions(client);
        return rows.map((row) => ({
          id: row.id,
          createdAt: row.createdAt,
          ...row.metadata,
        }));
      } finally {
        client.release();
      }
    },

    async delete(metadata) {
      await inTransaction(async (client) => {
        await requireSession(client, metadata.id);
        await deleteSession(client, metadata.id);
      });
    },

    /**
     * 复制源分支上的 entries 到新会话，records 不复制。
     * 源会话完全只读——所有写入都发生在新 session_id 下。
     */
    async fork(source, options) {
      const targetId = options?.id;
      if (!targetId) throw sessionError('invalid_payload', 'fork requires a target id');
      const at = options.at ?? null;

      await inTransaction(async (client) => {
        await requireSession(client, source.id);

        const branch = at
          ? await findEntriesOnBranch(client, source.id, { start: at })
          : [];
        if (at && branch.length === 0) {
          throw sessionError('invalid_fork_target', `Unknown fork target ${at}`);
        }

        await insertSession(client, {
          id: targetId,
          createdAt: Date.now(),
          parentSessionId: source.id,
          metadata: options.metadata ?? {},
        });

        let parentId = null;
        for (const entry of branch) {
          const seq = await nextSeq(client, targetId);
          const { type, id, timestamp, ...payload } = entry;
          delete payload.seq;
          delete payload.parentId;
          await client.query(
            `INSERT INTO ${SESSION_TABLES.entries}
               (session_id, id, seq, parent_id, type, custom_type, timestamp_ms, payload_json)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
            [
              targetId,
              id,
              seq,
              parentId,
              type,
              type === 'custom' ? (payload.customType ?? null) : null,
              timestamp,
              JSON.stringify(payload),
            ],
          );
          parentId = id;
        }

        await insertLane(client, targetId, DEFAULT_LANE, parentId);
      });

      return openSession(targetId);
    },
  };
}
