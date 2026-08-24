import type { PoolClient } from 'pg';
import { SESSION_TABLES } from './schema.js';

/**
 * 分配下一个 seq。全会话共享一条序列——entries、records、lane 变更、facts
 * 每次 mutation 都消耗一个。必须在调用方的事务内执行：行锁保证并发下不重号。
 */
export async function nextSeq(client: PoolClient, sessionId: string): Promise<number> {
  const result = await client.query(
    `UPDATE ${SESSION_TABLES.sequences}
        SET next_seq = next_seq + 1
      WHERE session_id = $1
      RETURNING next_seq - 1 AS seq`,
    [sessionId],
  );
  if (result.rowCount === 0) {
    throw new Error(`No sequence row for session ${sessionId}`);
  }
  return Number(result.rows[0]!.seq);
}
