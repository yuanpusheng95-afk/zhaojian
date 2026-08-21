export const SESSION_TABLES = {
  sessions: 'agent_sessions',
  sequences: 'agent_session_sequences',
  entries: 'agent_session_entries',
  lanes: 'agent_session_lanes',
  laneMoves: 'agent_session_lane_moves',
  records: 'agent_session_records',
  facts: 'agent_session_facts',
};

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
