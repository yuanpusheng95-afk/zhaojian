import { ENTRY_COLUMNS, rowToEntry } from './entries.mjs';
import { SESSION_TABLES } from './schema.mjs';

/** `id, seq, ...` → `e.id, e.seq, ...`，供递归 CTE 的递归项使用。 */
const ENTRY_COLUMNS_QUALIFIED = ENTRY_COLUMNS.split(', ')
  .map((column) => `e.${column}`)
  .join(', ');

function applyEntryFilters(query, conditions, params, prefix = '') {
  for (const [column, value] of [
    ['type', query.type],
    ['custom_type', query.customType],
  ]) {
    if (value !== undefined) {
      params.push(value);
      conditions.push(`${prefix}${column} = $${params.length}`);
    }
  }
}

export async function findEntries(client, sessionId, query = {}) {
  const conditions = ['session_id = $1'];
  const params = [sessionId];
  applyEntryFilters(query, conditions, params);

  let sql = `SELECT ${ENTRY_COLUMNS} FROM ${SESSION_TABLES.entries}
              WHERE ${conditions.join(' AND ')}
              ORDER BY seq ${query.order === 'desc' ? 'DESC' : 'ASC'}`;

  if (query.limit !== undefined) {
    params.push(query.limit);
    sql += ` LIMIT $${params.length}`;
  }

  const result = await client.query(sql, params);
  return result.rows.map(rowToEntry);
}

/**
 * 沿 parent_id 从 start 回溯到根，得到该分支的全部 entry。
 * sqlite 后端为此维护 branch_entries 派生缓存；PostgreSQL 用递归 CTE 现算，
 * 少一张需要维护一致性的表。
 */
export async function findEntriesOnBranch(client, sessionId, query = {}) {
  if (!query.start) {
    throw new Error('findEntriesOnBranch requires a start entry id');
  }

  const conditions = [];
  const params = [sessionId, query.start];
  applyEntryFilters(query, conditions, params, 'b.');

  let sql = `
    WITH RECURSIVE branch AS (
      SELECT ${ENTRY_COLUMNS}
        FROM ${SESSION_TABLES.entries}
       WHERE session_id = $1 AND id = $2
      UNION ALL
      SELECT ${ENTRY_COLUMNS_QUALIFIED}
        FROM ${SESSION_TABLES.entries} e
        JOIN branch ON e.id = branch.parent_id
       WHERE e.session_id = $1
    )
    SELECT ${ENTRY_COLUMNS} FROM branch b
    ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
    ORDER BY seq ${query.order === 'desc' ? 'DESC' : 'ASC'}`;

  if (query.limit !== undefined) {
    params.push(query.limit);
    sql += ` LIMIT $${params.length}`;
  }

  const result = await client.query(sql, params);
  return result.rows.map(rowToEntry);
}

/**
 * 会话的统一变更流水，按共享 seq 排序。afterSeq 是增量游标——
 * 将来的 SSE 端点（设计文档切片 3）直接建在它上面。
 */
export async function getLog(client, sessionId, options = {}) {
  const params = [sessionId];
  let cursor = '';
  if (options.afterSeq !== undefined) {
    params.push(options.afterSeq);
    cursor = `AND seq > $${params.length}`;
  }

  let sql = `
    SELECT seq, 'entry' AS kind, to_jsonb(e) AS item
      FROM (SELECT ${ENTRY_COLUMNS} FROM ${SESSION_TABLES.entries}
             WHERE session_id = $1 ${cursor}) e
    UNION ALL
    SELECT seq, 'record' AS kind, to_jsonb(r) AS item
      FROM (SELECT id, seq, lane, run_id, type, timestamp_ms, payload_json
              FROM ${SESSION_TABLES.records}
             WHERE session_id = $1 ${cursor}) r
    UNION ALL
    SELECT seq, 'lane_move' AS kind, to_jsonb(m) AS item
      FROM (SELECT seq, lane, leaf_id FROM ${SESSION_TABLES.laneMoves}
             WHERE session_id = $1 ${cursor}) m
    ORDER BY seq ASC`;

  if (options.limit !== undefined) {
    params.push(options.limit);
    sql += ` LIMIT $${params.length}`;
  }

  const result = await client.query(sql, params);
  return result.rows.map((row) => ({
    seq: Number(row.seq),
    kind: row.kind,
    item: row.item,
  }));
}
