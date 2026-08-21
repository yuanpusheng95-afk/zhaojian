import { SESSION_TABLES } from './schema.mjs';

const SELECT_COLUMNS = `
  id,
  (extract(epoch from created_at) * 1000)::bigint AS created_at_ms,
  parent_session_id,
  metadata_json
`;

function toRow(row) {
  return {
    id: row.id,
    createdAt: Number(row.created_at_ms),
    parentSessionId: row.parent_session_id,
    metadata: row.metadata_json ?? {},
  };
}

export async function insertSession(
  client,
  { id, createdAt, parentSessionId, metadata },
) {
  await client.query(
    `INSERT INTO ${SESSION_TABLES.sessions}
       (id, created_at, parent_session_id, metadata_json)
     VALUES ($1, to_timestamp($2 / 1000.0), $3, $4::jsonb)`,
    [id, createdAt, parentSessionId, JSON.stringify(metadata ?? {})],
  );
  await client.query(
    `INSERT INTO ${SESSION_TABLES.sequences} (session_id, next_seq)
     VALUES ($1, 1)`,
    [id],
  );
}

export async function readSession(client, id) {
  const result = await client.query(
    `SELECT ${SELECT_COLUMNS} FROM ${SESSION_TABLES.sessions} WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? toRow(result.rows[0]) : undefined;
}

export async function listSessions(client) {
  const result = await client.query(
    `SELECT ${SELECT_COLUMNS} FROM ${SESSION_TABLES.sessions}
      ORDER BY created_at DESC, id`,
  );
  return result.rows.map(toRow);
}

export async function deleteSession(client, id) {
  await client.query(`DELETE FROM ${SESSION_TABLES.sessions} WHERE id = $1`, [
    id,
  ]);
}
