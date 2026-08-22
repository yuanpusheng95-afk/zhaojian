import { SESSION_TABLES } from './schema.mjs';
import { nextSeq } from './sequences.mjs';

/** 追加一条 fact，读取时取同 (kind, key) 下 seq 最大的一条——latest wins。 */
export async function setFact(client, sessionId, kind, key, value) {
  const seq = await nextSeq(client, sessionId);
  await client.query(
    `INSERT INTO ${SESSION_TABLES.facts} (session_id, seq, kind, key, value)
     VALUES ($1, $2, $3, $4, $5)`,
    [sessionId, seq, kind, key, value ?? null],
  );
}

export async function getFact(client, sessionId, kind, key) {
  const result = await client.query(
    `SELECT value FROM ${SESSION_TABLES.facts}
      WHERE session_id = $1 AND kind = $2 AND key IS NOT DISTINCT FROM $3
      ORDER BY seq DESC
      LIMIT 1`,
    [sessionId, kind, key],
  );
  const value = result.rows[0]?.value;
  return value === null || value === undefined ? undefined : value;
}

/** 现算，不维护 session_stats 表——会话规模有限，省一处会不同步的派生状态。 */
export async function computeStats(client, sessionId) {
  const result = await client.query(
    `SELECT
       count(*) FILTER (WHERE type = 'message') AS message_count,
       coalesce(sum((payload_json -> 'message' -> 'usage' ->> 'cacheRead')::numeric), 0)
         AS cached_tokens,
       coalesce(sum((payload_json -> 'message' -> 'usage' ->> 'input')::numeric), 0)
         + coalesce(sum((payload_json -> 'message' -> 'usage' ->> 'output')::numeric), 0)
         AS uncached_tokens,
       coalesce(sum((payload_json -> 'message' -> 'usage' ->> 'totalTokens')::numeric), 0)
         AS total_tokens,
       coalesce(sum((payload_json -> 'message' -> 'usage' -> 'cost' ->> 'total')::numeric), 0)
         AS cost_total
     FROM ${SESSION_TABLES.entries}
     WHERE session_id = $1`,
    [sessionId],
  );
  const row = result.rows[0];
  return {
    messageCount: Number(row.message_count),
    cachedTokens: Number(row.cached_tokens),
    uncachedTokens: Number(row.uncached_tokens),
    totalTokens: Number(row.total_tokens),
    costTotal: Number(row.cost_total),
  };
}
