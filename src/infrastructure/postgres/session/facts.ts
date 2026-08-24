import type { PoolClient } from 'pg';
import { SESSION_TABLES } from './schema.js';
import { nextSeq } from './sequences.js';

/** 追加一条 fact，读取时取同 (kind, key) 下 seq 最大的一条——latest wins。 */
export async function setFact(
  client: PoolClient,
  sessionId: string,
  kind: string,
  key: string | null,
  value: unknown,
) {
  const seq = await nextSeq(client, sessionId);
  await client.query(
    `INSERT INTO ${SESSION_TABLES.facts} (session_id, seq, kind, key, value)
     VALUES ($1, $2, $3, $4, $5)`,
    [sessionId, seq, kind, key, value ?? null],
  );
}

export async function getFact(
  client: PoolClient,
  sessionId: string,
  kind: string,
  key: string | null,
) {
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

/**
 * 现算，不维护 session_stats 表。
 *
 * 口径按 pi 的 SessionState：messageCount 来自 message 类型的 entries，
 * token 与成本来自 **`usage` 类型的 records**——不是 message entry 里的 usage 字段。
 * uncachedTokens = input + cacheWrite。
 */
export async function computeStats(client: PoolClient, sessionId: string) {
  const [messages, usage] = await Promise.all([
    client.query(
      `SELECT count(*) AS message_count FROM ${SESSION_TABLES.entries}
        WHERE session_id = $1 AND type = 'message'`,
      [sessionId],
    ),
    client.query(
      `SELECT
         coalesce(sum((payload_json -> 'usage' ->> 'cacheRead')::numeric), 0) AS cached_tokens,
         coalesce(sum((payload_json -> 'usage' ->> 'input')::numeric), 0)
           + coalesce(sum((payload_json -> 'usage' ->> 'cacheWrite')::numeric), 0)
           AS uncached_tokens,
         coalesce(sum((payload_json -> 'usage' ->> 'totalTokens')::numeric), 0) AS total_tokens,
         coalesce(sum((payload_json -> 'usage' -> 'cost' ->> 'total')::numeric), 0) AS cost_total
       FROM ${SESSION_TABLES.records}
       WHERE session_id = $1 AND type = 'usage'`,
      [sessionId],
    ),
  ]);

  const row = usage.rows[0];
  return {
    messageCount: Number(messages.rows[0]?.message_count ?? 0),
    cachedTokens: Number(row?.cached_tokens ?? 0),
    uncachedTokens: Number(row?.uncached_tokens ?? 0),
    totalTokens: Number(row?.total_tokens ?? 0),
    costTotal: Number(row?.cost_total ?? 0),
  };
}
