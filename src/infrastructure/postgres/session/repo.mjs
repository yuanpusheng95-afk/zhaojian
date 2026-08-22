import { Session, uuidv7 } from '@earendil-works/pi-agent-core';

import { isUniqueViolation, sessionError } from './errors.mjs';
import { readEntry } from './entries.mjs';
import { getFact, setFact } from './facts.mjs';
import { insertLane, readLaneLeaf, readLanes, recordLaneMove } from './lanes.mjs';
import { findEntries, findEntriesOnBranch } from './queries.mjs';
import { SESSION_TABLES, claimId } from './schema.mjs';
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
     * 复制源会话的 entries 到新会话，records 不复制、facts 选择性复制。
     * 语义对齐 pi 的 SessionState.createForkMutations：
     *   scope=tree   → 全部 entries + 全部 lanes
     *   scope=branch → 目标点所在分支 + 单个 main lane
     *   position 默认：未给 entryId 时为 'at'，给了则为 'before'
     * 复制的 entry 保留原 id / parentId / timestamp，但 seq 从 1 重新编号；
     * lane 与 fact 同样各消耗一个 seq。
     */
    async fork(source, options = {}) {
      const targetId = options.id ?? uuidv7();

      await inTransaction(async (client) => {
        await requireSession(client, source.id);

        let copiedEntries;
        let forkLanes;

        if (options.scope === 'tree') {
          copiedEntries = await findEntries(client, source.id, {});
          forkLanes = await readLanes(client, source.id);
        } else {
          const mainLeaf = await readLaneLeaf(client, source.id, 'main');
          if (mainLeaf === undefined) {
            throw sessionError('not_found', 'Session has no main lane');
          }
          const selectedEntryId = options.entryId ?? mainLeaf;

          let branchTarget = null;
          if (selectedEntryId !== null) {
            const entry = await readEntry(client, source.id, selectedEntryId);
            if (!entry || entry.type !== 'message') {
              throw sessionError(
                'invalid_fork_target',
                `Fork target is not a message entry: ${selectedEntryId}`,
              );
            }
            const position =
              options.position ?? (options.entryId === undefined ? 'at' : 'before');
            branchTarget = position === 'at' ? entry.id : entry.parentId;
          }

          copiedEntries =
            branchTarget === null
              ? []
              : await findEntriesOnBranch(client, source.id, { start: branchTarget });
          forkLanes = [{ lane: 'main', leafId: branchTarget }];
        }

        const sourceName = await getFact(client, source.id, 'name', null);

        await insertSession(client, {
          id: targetId,
          createdAt: Date.now(),
          parentSessionId: options.parentSessionId ?? source.id,
          metadata: options.metadata ?? {},
        });

        for (const entry of copiedEntries) {
          await claimId(client, targetId, entry.id, 'entry');
          const seq = await nextSeq(client, targetId);
          const { type, id, timestamp, parentId, ...payload } = entry;
          delete payload.seq;
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
        }

        for (const pointer of forkLanes) {
          await insertLane(client, targetId, pointer.lane, pointer.leafId);
          await recordLaneMove(client, targetId, pointer.lane, pointer.leafId);
        }

        if (sourceName !== undefined) {
          await setFact(client, targetId, 'name', null, sourceName);
        }

        for (const entry of copiedEntries) {
          const label = await getFact(client, source.id, 'label', entry.id);
          if (label !== undefined) {
            await setFact(client, targetId, 'label', entry.id, label);
          }
        }
      });

      return openSession(targetId);
    },
  };
}
