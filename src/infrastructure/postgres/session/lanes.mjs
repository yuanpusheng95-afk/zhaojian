import { SESSION_TABLES } from './schema.mjs';
import { nextSeq } from './sequences.mjs';

export async function readLanes(client, sessionId) {
  const result = await client.query(
    `SELECT lane, leaf_id FROM ${SESSION_TABLES.lanes} WHERE session_id = $1`,
    [sessionId],
  );
  return result.rows.map((row) => ({ lane: row.lane, leafId: row.leaf_id }));
}

/** 返回 undefined 表示 lane 不存在；返回 null 表示 lane 存在但为空。 */
export async function readLaneLeaf(client, sessionId, lane) {
  const result = await client.query(
    `SELECT leaf_id FROM ${SESSION_TABLES.lanes}
      WHERE session_id = $1 AND lane = $2`,
    [sessionId, lane],
  );
  return result.rows[0] ? result.rows[0].leaf_id : undefined;
}

export async function recordLaneMove(client, sessionId, lane, leafId) {
  const seq = await nextSeq(client, sessionId);
  await client.query(
    `INSERT INTO ${SESSION_TABLES.laneMoves} (session_id, seq, lane, leaf_id)
     VALUES ($1, $2, $3, $4)`,
    [sessionId, seq, lane, leafId],
  );
  return seq;
}

/**
 * 只插入 lane 行，不消耗 seq、不记 lane_move。
 * 供 repo.create() 建默认 lane 用——conformance 要求 create() 之后
 * 第一条 appendEntry 拿到 seq 1，因此建库时的默认 lane 必须是「免费」的。
 */
export async function insertLane(client, sessionId, lane, at) {
  await client.query(
    `INSERT INTO ${SESSION_TABLES.lanes} (session_id, lane, leaf_id)
     VALUES ($1, $2, $3)`,
    [sessionId, lane, at],
  );
}

/** 显式建 lane：插入行并消耗一个 seq——conformance 第一个用例依赖这一点。 */
export async function createLane(client, sessionId, lane, at) {
  await insertLane(client, sessionId, lane, at);
  await recordLaneMove(client, sessionId, lane, at);
}

export async function moveLane(client, sessionId, lane, to) {
  await client.query(
    `UPDATE ${SESSION_TABLES.lanes} SET leaf_id = $3
      WHERE session_id = $1 AND lane = $2`,
    [sessionId, lane, to],
  );
  await recordLaneMove(client, sessionId, lane, to);
}

/** 追加 entry 后推进 leaf，不产生 lane_move 流水——它属于 entry 的 mutation。 */
export async function advanceLaneLeaf(client, sessionId, lane, leafId) {
  await client.query(
    `UPDATE ${SESSION_TABLES.lanes} SET leaf_id = $3
      WHERE session_id = $1 AND lane = $2`,
    [sessionId, lane, leafId],
  );
}
