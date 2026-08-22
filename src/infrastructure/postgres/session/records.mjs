import { assertJsonSerializable, SESSION_TABLES } from './schema.mjs';
import { nextSeq } from './sequences.mjs';

const RECORD_COLUMNS =
  'id, seq, lane, run_id, type, op_kind, timestamp_ms, payload_json';

function rowToRecord(row) {
  return {
    ...row.payload_json,
    type: row.type,
    id: row.id,
    seq: Number(row.seq),
    lane: row.lane,
    timestamp: Number(row.timestamp_ms),
  };
}

export async function appendRecord(client, sessionId, newRecord) {
  const { type, id, lane, ...rest } = newRecord;
  // 必须先于任何写入与任何 seq 分配
  const payload = assertJsonSerializable(rest, `record ${id}`);

  const seq = await nextSeq(client, sessionId);
  const timestamp = Date.now();

  await client.query(
    `INSERT INTO ${SESSION_TABLES.records}
       (session_id, id, seq, lane, run_id, type, op_kind, timestamp_ms, payload_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      sessionId,
      id,
      seq,
      lane,
      rest.runId ?? null,
      type,
      rest.intent?.kind ?? null,
      timestamp,
      JSON.stringify(payload),
    ],
  );

  return { ...payload, type, id, seq, lane, timestamp };
}

export async function findRecords(client, sessionId, query = {}) {
  const conditions = ['session_id = $1'];
  const params = [sessionId];

  for (const [column, value] of [
    ['type', query.type],
    ['lane', query.lane],
    ['run_id', query.runId],
  ]) {
    if (value !== undefined) {
      params.push(value);
      conditions.push(`${column} = $${params.length}`);
    }
  }

  let sql = `SELECT ${RECORD_COLUMNS} FROM ${SESSION_TABLES.records}
              WHERE ${conditions.join(' AND ')}
              ORDER BY seq ${query.order === 'desc' ? 'DESC' : 'ASC'}`;

  if (query.limit !== undefined) {
    params.push(query.limit);
    sql += ` LIMIT $${params.length}`;
  }

  const result = await client.query(sql, params);
  return result.rows.map(rowToRecord);
}

/**
 * 未闭合的 operation_started：不存在引用其 id 且排在它之后的 operation_finished。
 * seq 比较不可省——早于某个 start 的 finish 不能关掉它。
 * 按 seq 倒序返回；恢复逻辑用 limit:2 判断 idle / suspended / 损坏。
 */
export async function findOpenOperations(client, sessionId, lane, options = {}) {
  const params = [sessionId, lane];
  let sql = `
    SELECT ${RECORD_COLUMNS}
      FROM ${SESSION_TABLES.records} started
     WHERE started.session_id = $1
       AND started.lane = $2
       AND started.type = 'operation_started'
       AND NOT EXISTS (
         SELECT 1 FROM ${SESSION_TABLES.records} finished
          WHERE finished.session_id = started.session_id
            AND finished.type = 'operation_finished'
            AND finished.run_id = started.id
            AND finished.seq > started.seq
       )
     ORDER BY started.seq DESC`;

  if (options.limit !== undefined) {
    params.push(options.limit);
    sql += ` LIMIT $${params.length}`;
  }

  const result = await client.query(sql, params);
  return result.rows.map(rowToRecord);
}
