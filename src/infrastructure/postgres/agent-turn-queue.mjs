import { randomUUID } from 'node:crypto';

export class IdempotencyConflictError extends Error {
  constructor(projectId, idempotencyKey) {
    super(`Idempotency key ${idempotencyKey} was reused with a different message in project ${projectId}`);
    this.name = this.constructor.name;
    this.code = 'IDEMPOTENCY_CONFLICT';
  }
}

export class ProjectBusyError extends Error {
  constructor(projectId, turnId) {
    super(`Project ${projectId} already has a running turn: ${turnId}`);
    this.name = this.constructor.name;
    this.code = 'PROJECT_BUSY';
  }
}

export class TurnLeaseLostError extends Error {
  constructor(turnId) {
    super(`Turn lease is lost: ${turnId}`);
    this.name = this.constructor.name;
    this.code = 'TURN_LEASE_LOST';
  }
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'aborted']);

async function withTransaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function createAgentTurnQueue({ pool, leaseMs = 30_000 }) {
  if (!pool) throw new TypeError('createAgentTurnQueue requires a pool');
  if (!Number.isInteger(leaseMs) || leaseMs <= 0) {
    throw new TypeError('createAgentTurnQueue requires a positive integer leaseMs');
  }

  async function requireProject(client, projectId, { forUpdate = false } = {}) {
    const result = await client.query(
      `SELECT * FROM projects WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [projectId],
    );
    if (result.rowCount === 0) {
      const error = new Error(`Project not found: ${projectId}`);
      error.code = 'PROJECT_NOT_FOUND';
      throw error;
    }
    return result.rows[0];
  }

  async function requireRunningTurnWithLease(client, turnId, leaseToken) {
    const result = await client.query(
      'SELECT * FROM agent_turns WHERE id = $1 FOR UPDATE',
      [turnId],
    );
    const turn = result.rows[0];
    if (!turn || turn.status !== 'running' || turn.lease_token !== leaseToken) {
      throw new TurnLeaseLostError(turnId);
    }
    return turn;
  }

  return {
    requestTurn({ projectId, userMessage, idempotencyKey }) {
      if (typeof userMessage !== 'string' || userMessage.trim() === '') {
        throw new TypeError('requestTurn requires a non-empty user message');
      }
      if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
        throw new TypeError('requestTurn requires a non-empty idempotency key');
      }

      return withTransaction(pool, async (client) => {
        // 项目行锁先于一切判断：并发同 key 的两个请求在此串行化，
        // 后到者在锁内必然能看到先到者写入的行——幂等重放而不是误报 PROJECT_BUSY
        const project = await requireProject(client, projectId, { forUpdate: true });

        const existingResult = await client.query(
          `SELECT id, user_message FROM agent_turns
           WHERE project_id = $1 AND idempotency_key = $2`,
          [projectId, idempotencyKey],
        );
        const existing = existingResult.rows[0];

        if (existing) {
          if (existing.user_message !== userMessage) {
            throw new IdempotencyConflictError(projectId, idempotencyKey);
          }
          return { turnId: existing.id, replayed: true };
        }

        if (project.running_turn_id) {
          throw new ProjectBusyError(projectId, project.running_turn_id);
        }

        const inserted = await client.query(
          `INSERT INTO agent_turns
            (id, project_id, user_message, idempotency_key, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'queued', now(), now())
           ON CONFLICT (project_id, idempotency_key) DO NOTHING
           RETURNING id`,
          [`turn_${randomUUID()}`, projectId, userMessage, idempotencyKey],
        );
        if (inserted.rowCount > 0) {
          await client.query(
            `UPDATE projects SET running_turn_id = $2, updated_at = now() WHERE id = $1`,
            [projectId, inserted.rows[0].id],
          );
          return { turnId: inserted.rows[0].id, replayed: false };
        }

        // 项目行锁已串行化同项目并发；走到这里只是防御性兜底——回读并按幂等三态收口，
        // 绝不让调用方拿到 undefined
        const raced = await client.query(
          `SELECT id, user_message FROM agent_turns
           WHERE project_id = $1 AND idempotency_key = $2`,
          [projectId, idempotencyKey],
        );
        const winner = raced.rows[0];
        if (!winner || winner.user_message !== userMessage) {
          throw new IdempotencyConflictError(projectId, idempotencyKey);
        }
        return { turnId: winner.id, replayed: true };
      });
    },

    claimNextTurn() {
      return withTransaction(pool, async (client) => {
        const queued = await client.query(
          `SELECT id AS "turnId", project_id AS "projectId", user_message FROM agent_turns
           WHERE status = 'queued'
           ORDER BY created_at, id
           LIMIT 1
           FOR UPDATE SKIP LOCKED`,
        );
        if (queued.rowCount === 0) return null;

        const turn = queued.rows[0];
        const leaseToken = randomUUID();
        await client.query(
          `UPDATE agent_turns
           SET status = 'running', lease_token = $2,
               lease_expires_at = now() + make_interval(secs => $3 / 1000.0),
               updated_at = now()
           WHERE id = $1`,
          [turn.turnId, leaseToken, leaseMs],
        );
        return {
          turnId: turn.turnId,
          projectId: turn.projectId,
          userMessage: turn.user_message,
          leaseToken,
        };
      });
    },

    failExpiredTurns() {
      return withTransaction(pool, async (client) => {
        const expired = await client.query(
          `SELECT id, project_id FROM agent_turns
           WHERE status = 'running' AND lease_expires_at <= now()
           FOR UPDATE`,
        );
        for (const turn of expired.rows) {
          await client.query(
            `UPDATE agent_turns
             SET status = 'failed', error_json = $2::jsonb, updated_at = now()
             WHERE id = $1`,
            [
              turn.id,
              JSON.stringify({
                code: 'WORKER_LEASE_EXPIRED',
                message: 'The turn lease expired before the worker finished.',
              }),
            ],
          );
          await client.query(
            `UPDATE projects SET running_turn_id = NULL, updated_at = now()
             WHERE id = $1 AND running_turn_id = $2`,
            [turn.project_id, turn.id],
          );
        }
        return expired.rowCount;
      });
    },

    renewTurnLease({ turnId, leaseToken }) {
      return withTransaction(pool, async (client) => {
        await requireRunningTurnWithLease(client, turnId, leaseToken);
        await client.query(
          `UPDATE agent_turns
           SET lease_expires_at = now() + make_interval(secs => $2 / 1000.0), updated_at = now()
           WHERE id = $1`,
          [turnId, leaseMs],
        );
      });
    },

    finishTurn({ turnId, leaseToken, status, outcome = null, error = null }) {
      if (!TERMINAL_STATUSES.has(status)) {
        throw new TypeError('finishTurn status must be completed, failed, or aborted');
      }
      return withTransaction(pool, async (client) => {
        const result = await client.query(
          'SELECT * FROM agent_turns WHERE id = $1 FOR UPDATE',
          [turnId],
        );
        const turn = result.rows[0];
        if (!turn) throw new TurnLeaseLostError(turnId);
        if (turn.status !== 'running') {
          if (
            turn.status === status &&
            (turn.lease_token === leaseToken || !turn.lease_token)
          ) {
            return { turnId, status };
          }
          throw new TurnLeaseLostError(turnId);
        }
        if (turn.lease_token !== leaseToken) throw new TurnLeaseLostError(turnId);
        await client.query(
          `UPDATE agent_turns
           SET status = $2, outcome_json = $3::jsonb, error_json = $4::jsonb,
               lease_token = NULL, lease_expires_at = NULL, updated_at = now()
           WHERE id = $1`,
          [turnId, status, outcome ? JSON.stringify(outcome) : null, error ? JSON.stringify(error) : null],
        );
        await client.query(
          `UPDATE projects SET running_turn_id = NULL, updated_at = now()
           WHERE id = $1 AND running_turn_id = $2`,
          [turn.project_id, turnId],
        );
        return { turnId, status };
      });
    },
  };
}
