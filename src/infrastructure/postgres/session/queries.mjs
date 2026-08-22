import { ENTRY_COLUMNS, rowToEntry } from './entries.mjs';
import { sessionError } from './errors.mjs';
import { RECORD_COLUMNS, rowToRecord } from './records.mjs';
import { SESSION_TABLES } from './schema.mjs';

function assertValidLimit(limit) {
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw sessionError('invalid_query', 'limit must be a positive integer');
  }
}

function assertValidCursor(afterSeq) {
  if (afterSeq !== undefined && (!Number.isInteger(afterSeq) || afterSeq < 0)) {
    throw sessionError(
      'invalid_query',
      'cursor sequence must be a non-negative integer',
    );
  }
}

/** `id, seq, ...` → `e.id, e.seq, ...`，供递归 CTE 的递归项使用。 */
const ENTRY_COLUMNS_QUALIFIED = ENTRY_COLUMNS.split(', ')
  .map((column) => `e.${column}`)
  .join(', ');

/** pi 的默认顺序是 newestFirst；只有显式 oldestFirst 才升序。 */
function orderClause(order) {
  return order === 'oldestFirst' ? 'ASC' : 'DESC';
}

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
  if (query.cursor?.afterSeq !== undefined) {
    params.push(query.cursor.afterSeq);
    conditions.push(`${prefix}seq > $${params.length}`);
  }
}

export async function findEntries(client, sessionId, query = {}) {
  assertValidLimit(query.limit);
  assertValidCursor(query.cursor?.afterSeq);

  const conditions = ['session_id = $1'];
  const params = [sessionId];
  applyEntryFilters(query, conditions, params);

  let sql = `SELECT ${ENTRY_COLUMNS} FROM ${SESSION_TABLES.entries}
              WHERE ${conditions.join(' AND ')}
              ORDER BY seq ${orderClause(query.order)}`;

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
 *
 * stopAtId / stopAtType 是包含式边界：扫描在第一个命中之后结束。
 */
export async function findEntriesOnBranch(client, sessionId, query = {}) {
  if (!query.start) {
    throw new Error('findEntriesOnBranch requires a start entry id');
  }
  assertValidLimit(query.limit);
  assertValidCursor(query.cursor?.afterSeq);

  const params = [sessionId, query.start];
  const sql = `
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
    SELECT ${ENTRY_COLUMNS} FROM branch ORDER BY seq DESC`;

  const result = await client.query(sql, params);
  // 从 leaf 向 root 的顺序（seq 降序）应用包含式边界，与 walkToRoot 一致
  const walked = [];
  for (const row of result.rows) {
    const entry = rowToEntry(row);
    walked.push(entry);
    if (entry.id === query.stopAtId || entry.type === query.stopAtType) break;
  }

  const ordered = query.order === 'oldestFirst' ? walked.reverse() : walked;
  const filtered = ordered.filter(
    (entry) =>
      (query.type === undefined || entry.type === query.type) &&
      (query.customType === undefined || entry.customType === query.customType) &&
      (query.cursor?.afterSeq === undefined || entry.seq > query.cursor.afterSeq),
  );

  return query.limit === undefined ? filtered : filtered.slice(0, query.limit);
}

/**
 * 会话的统一变更流水，按共享 seq 排序。afterSeq 是增量游标——
 * 将来的 SSE 端点（设计文档切片 3）直接建在它上面。
 *
 * LogItem 是判别联合，每种 kind 带自己的载荷键，因此分表查询后在 JS 里
 * 归并，而不是用 SQL UNION 拼裸行。
 */
export async function getLog(client, sessionId, options = {}) {
  assertValidCursor(options.afterSeq);
  assertValidLimit(options.limit);

  const cursorParams = [sessionId];
  let cursor = '';
  if (options.afterSeq !== undefined) {
    cursorParams.push(options.afterSeq);
    cursor = 'AND seq > $2';
  }

  const [entries, records, facts, laneMoves] = await Promise.all([
    client.query(
      `SELECT ${ENTRY_COLUMNS} FROM ${SESSION_TABLES.entries}
        WHERE session_id = $1 ${cursor}`,
      cursorParams,
    ),
    client.query(
      `SELECT ${RECORD_COLUMNS} FROM ${SESSION_TABLES.records}
        WHERE session_id = $1 ${cursor}`,
      cursorParams,
    ),
    client.query(
      `SELECT seq, kind, key, value FROM ${SESSION_TABLES.facts}
        WHERE session_id = $1 ${cursor}`,
      cursorParams,
    ),
    client.query(
      `SELECT seq, lane, leaf_id FROM ${SESSION_TABLES.laneMoves}
        WHERE session_id = $1 ${cursor}`,
      cursorParams,
    ),
  ]);

  const items = [
    ...entries.rows.map((row) => ({
      kind: 'entry',
      seq: Number(row.seq),
      entry: rowToEntry(row),
    })),
    ...records.rows.map((row) => ({
      kind: 'record',
      seq: Number(row.seq),
      record: rowToRecord(row),
    })),
    ...facts.rows.map((row) =>
      row.kind === 'name'
        ? {
            kind: 'fact',
            seq: Number(row.seq),
            fact: 'name',
            name: row.value ?? undefined,
          }
        : {
            kind: 'fact',
            seq: Number(row.seq),
            fact: 'label',
            targetId: row.key,
            label: row.value ?? undefined,
          },
    ),
    ...laneMoves.rows.map((row) => ({
      kind: 'lane',
      seq: Number(row.seq),
      lane: row.lane,
      leafId: row.leaf_id,
    })),
  ].sort((a, b) => a.seq - b.seq);

  return options.limit === undefined ? items : items.slice(0, options.limit);
}
