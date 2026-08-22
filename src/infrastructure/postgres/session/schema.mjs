export const SESSION_TABLES = {
  sessions: 'agent_sessions',
  sequences: 'agent_session_sequences',
  ids: 'agent_session_ids',
  entries: 'agent_session_entries',
  lanes: 'agent_session_lanes',
  laneMoves: 'agent_session_lane_moves',
  records: 'agent_session_records',
  facts: 'agent_session_facts',
};

/**
 * 占用一个 id。entries 与 records 共享命名空间，重复会抛 23505，
 * 由调用方转成 already_exists。必须先于 seq 分配调用：失败时事务回滚，
 * seq 计数器的自增一并撤销，不会漏号。
 */
export async function claimId(client, sessionId, id, kind) {
  await client.query(
    `INSERT INTO ${SESSION_TABLES.ids} (session_id, id, kind) VALUES ($1, $2, $3)`,
    [sessionId, id, kind],
  );
}

/** pi 要求 payload 必须可 JSON 序列化。不可序列化时抛错，由调用方转成 SessionError。 */
export function assertJsonSerializable(value, what) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (cause) {
    throw new TypeError(`${what} is not JSON-serializable`, { cause });
  }
  if (serialized === undefined) {
    throw new TypeError(`${what} is not JSON-serializable`);
  }
  return JSON.parse(serialized);
}
