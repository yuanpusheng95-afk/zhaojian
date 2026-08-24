import type { PoolClient } from 'pg';
import { advanceLaneLeaf, requireLane } from './lanes.js';
import { assertJsonSerializable, claimId, SESSION_TABLES } from './schema.js';
import { nextSeq } from './sequences.js';
import type { SessionEntryRow } from './types.js';

export const ENTRY_COLUMNS =
  'id, seq, parent_id, type, custom_type, timestamp_ms, payload_json';

export function rowToEntry(row: SessionEntryRow) {
  return {
    ...row.payload_json,
    type: row.type,
    id: row.id,
    seq: Number(row.seq),
    parentId: row.parent_id,
    timestamp: Number(row.timestamp_ms),
  };
}

/** 存储层分配 parentId / seq / timestamp，调用方只提供其余字段。 */
export async function appendEntry(client: PoolClient, sessionId: string, provisioned: any, lane: string) {
  const { type, id, ...rest } = provisioned;
  // 必须先于任何写入与任何 seq 分配：非法 payload 不得消耗序列号
  const payload = assertJsonSerializable(rest, `entry ${id}`);

  const leafId = await requireLane(client, sessionId, lane);

  await claimId(client, sessionId, id, 'entry');

  const seq = await nextSeq(client, sessionId);
  const timestamp = Date.now();

  await client.query(
    `INSERT INTO ${SESSION_TABLES.entries}
       (session_id, id, seq, parent_id, type, custom_type, timestamp_ms, payload_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      sessionId,
      id,
      seq,
      leafId,
      type,
      type === 'custom' ? (rest.customType ?? null) : null,
      timestamp,
      JSON.stringify(payload),
    ],
  );

  await advanceLaneLeaf(client, sessionId, lane, id);

  return { ...payload, type, id, seq, parentId: leafId, timestamp };
}

export async function readEntry(client: PoolClient, sessionId: string, id: string) {
  const result = await client.query(
    `SELECT ${ENTRY_COLUMNS} FROM ${SESSION_TABLES.entries}
      WHERE session_id = $1 AND id = $2`,
    [sessionId, id],
  );
  return result.rows[0] ? rowToEntry(result.rows[0]) : undefined;
}
