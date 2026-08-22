import { sessionError } from './errors.mjs';
import { requireLane } from './lanes.mjs';
import { assertJsonSerializable, claimId, SESSION_TABLES } from './schema.mjs';
import { nextSeq } from './sequences.mjs';

export const RECORD_COLUMNS =
  'id, seq, lane, run_id, type, op_kind, timestamp_ms, payload_json';

export function rowToRecord(row) {
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

  await requireLane(client, sessionId, lane);
  await claimId(client, sessionId, id, 'record');

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
  if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit <= 0)) {
    throw sessionError('invalid_query', 'limit must be a positive integer');
  }
  if (
    query.afterSeq !== undefined &&
    (!Number.isInteger(query.afterSeq) || query.afterSeq < 0)
  ) {
    throw sessionError(
      'invalid_query',
      'cursor sequence must be a non-negative integer',
    );
  }

  const conditions = ['session_id = $1'];
  const params = [sessionId];

  for (const [column, value] of [
    ['type', query.type],
    ['lane', query.lane],
  ]) {
    if (value !== undefined) {
      params.push(value);
      conditions.push(`${column} = $${params.length}`);
    }
  }

  // runId 同时匹配 operation_started 自身的 id 与其他记录的 runId 属性；
  // 没有操作身份的记录一律不匹配。
  if (query.runId !== undefined) {
    params.push(query.runId);
    const p = `$${params.length}`;
    conditions.push(
      `((type = 'operation_started' AND id = ${p}) OR (type <> 'operation_started' AND run_id = ${p}))`,
    );
  }

  // operationKind 仅对 operation_started 有意义
  if (query.operationKind !== undefined) {
    params.push(query.operationKind);
    conditions.push(
      `(type = 'operation_started' AND op_kind = $${params.length})`,
    );
  }

  if (query.afterSeq !== undefined) {
    params.push(query.afterSeq);
    conditions.push(`seq > $${params.length}`);
  }

  // pi 的默认顺序是 newestFirst
  let sql = `SELECT ${RECORD_COLUMNS} FROM ${SESSION_TABLES.records}
              WHERE ${conditions.join(' AND ')}
              ORDER BY seq ${query.order === 'oldestFirst' ? 'ASC' : 'DESC'}`;

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
