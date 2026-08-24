import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export class IdempotencyConflictError extends Error {
  code = "IDEMPOTENCY_CONFLICT";
  constructor(projectId: string, idempotencyKey: string) {
    super(`Idempotency key ${idempotencyKey} was reused with a different message in project ${projectId}`);
    this.name = this.constructor.name;
  }
}

export class ProjectBusyError extends Error {
  code = "PROJECT_BUSY";
  constructor(projectId: string, turnId: string) {
    super(`Project ${projectId} already has a running turn: ${turnId}`);
    this.name = this.constructor.name;
  }
}

export class TurnLeaseLostError extends Error {
  code = "TURN_LEASE_LOST";
  constructor(turnId: string) {
    super(`Turn lease is lost: ${turnId}`);
    this.name = this.constructor.name;
  }
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "aborted"]);

async function withTransaction<T>(pool: Pool, callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function createAgentTurnQueue({ pool, leaseMs = 30_000, eventPublisher }: {
  pool: Pool; leaseMs?: number; eventPublisher?: { publishTurnEvent(event: any): Promise<void> };
}) {
  if (!pool) throw new TypeError("createAgentTurnQueue requires a pool");
  if (!Number.isInteger(leaseMs) || leaseMs <= 0) {
    throw new TypeError("createAgentTurnQueue requires a positive integer leaseMs");
  }

  async function requireProject(client: PoolClient, projectId: string, { forUpdate = false } = {}) {
    const result = await client.query(
      `SELECT * FROM projects WHERE id = $1${forUpdate ? " FOR UPDATE" : ""}`, [projectId]);
    if (result.rowCount === 0) {
      const error = new Error(`Project not found: ${projectId}`) as any;
      error.code = "PROJECT_NOT_FOUND";
      throw error;
    }
    return result.rows[0];
  }

  async function requireRunningTurnWithLease(client: PoolClient, turnId: string, leaseToken: string) {
    const result = await client.query("SELECT * FROM agent_turns WHERE id = $1 FOR UPDATE", [turnId]);
    const turn = result.rows[0];
    if (!turn || turn.status !== "running" || turn.lease_token !== leaseToken) {
      throw new TurnLeaseLostError(turnId);
    }
    return turn;
  }

  return {
    requestTurn({ projectId, userMessage, idempotencyKey }: { projectId: string; userMessage: string; idempotencyKey: string }) {
      if (typeof userMessage !== "string" || userMessage.trim() === "") throw new TypeError("requestTurn requires a non-empty user message");
      if (typeof idempotencyKey !== "string" || idempotencyKey.trim() === "") throw new TypeError("requestTurn requires a non-empty idempotency key");

      return withTransaction(pool, async (client) => {
        const project = await requireProject(client, projectId, { forUpdate: true });

        const existingResult = await client.query(
          "SELECT id, user_message FROM agent_turns WHERE project_id = $1 AND idempotency_key = $2", [projectId, idempotencyKey]);
        const existing = existingResult.rows[0];

        if (existing) {
          if (existing.user_message !== userMessage) throw new IdempotencyConflictError(projectId, idempotencyKey);
          return { turnId: existing.id as string, replayed: true };
        }

        if (project.running_turn_id) throw new ProjectBusyError(projectId, project.running_turn_id);

        const inserted = await client.query(
          `INSERT INTO agent_turns (id, project_id, user_message, idempotency_key, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'queued', now(), now())
           ON CONFLICT (project_id, idempotency_key) DO NOTHING
           RETURNING id`,
          [`turn_${randomUUID()}`, projectId, userMessage, idempotencyKey],
        );
        if (inserted.rowCount! > 0) {
          await client.query("UPDATE projects SET running_turn_id = $2, updated_at = now() WHERE id = $1", [projectId, inserted.rows[0].id]);
          return { turnId: inserted.rows[0].id as string, replayed: false };
        }

        const raced = await client.query(
          "SELECT id, user_message FROM agent_turns WHERE project_id = $1 AND idempotency_key = $2", [projectId, idempotencyKey]);
        const winner = raced.rows[0];
        if (!winner || winner.user_message !== userMessage) throw new IdempotencyConflictError(projectId, idempotencyKey);
        return { turnId: winner.id as string, replayed: true };
      });
    },

    claimNextTurn() {
      return withTransaction(pool, async (client) => {
        const queued = await client.query(
          `SELECT id AS "turnId", project_id AS "projectId", user_message FROM agent_turns
           WHERE status = 'queued' ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`);
        if (queued.rowCount === 0) return null;

        const turn = queued.rows[0];
        const leaseToken = randomUUID();
        await client.query(
          `UPDATE agent_turns SET status = 'running', lease_token = $2,
             lease_expires_at = now() + make_interval(secs => $3 / 1000.0), updated_at = now()
           WHERE id = $1`, [turn.turnId, leaseToken, leaseMs]);
        return {
          turnId: turn.turnId as string,
          projectId: turn.projectId as string,
          userMessage: turn.user_message as string,
          leaseToken,
        };
      });
    },

    failExpiredTurns() {
      return withTransaction(pool, async (client) => {
        const expired = await client.query(
          `SELECT id, project_id FROM agent_turns
           WHERE status = 'running' AND lease_expires_at <= now() FOR UPDATE`);
        for (const turn of expired.rows) {
          await client.query(
            "UPDATE agent_turns SET status = 'failed', error_json = $2::jsonb, updated_at = now() WHERE id = $1",
            [turn.id, JSON.stringify({ code: "WORKER_LEASE_EXPIRED", message: "The turn lease expired before the worker finished." })],
          );
          await client.query(
            "UPDATE projects SET running_turn_id = NULL, updated_at = now() WHERE id = $1 AND running_turn_id = $2",
            [turn.project_id, turn.id],
          );
        }
        return expired.rowCount ?? 0;
      });
    },

    renewTurnLease({ turnId, leaseToken }: { turnId: string; leaseToken: string }) {
      return withTransaction(pool, async (client) => {
        await requireRunningTurnWithLease(client, turnId, leaseToken);
        await client.query(
          "UPDATE agent_turns SET lease_expires_at = now() + make_interval(secs => $2 / 1000.0), updated_at = now() WHERE id = $1",
          [turnId, leaseMs],
        );
      });
    },

    finishTurn({ turnId, leaseToken, status, outcome = null, error = null }: {
      turnId: string; leaseToken: string; status: string; outcome?: Record<string, unknown> | null; error?: Record<string, unknown> | null;
    }) {
      if (!TERMINAL_STATUSES.has(status)) throw new TypeError("finishTurn status must be completed, failed, or aborted");
      return withTransaction(pool, async (client) => {
        const result = await client.query("SELECT * FROM agent_turns WHERE id = $1 FOR UPDATE", [turnId]);
        const turn = result.rows[0];
        if (!turn) throw new TurnLeaseLostError(turnId);
        if (turn.status !== "running") {
          if (turn.status === status && (turn.lease_token === leaseToken || !turn.lease_token)) return { turnId, status };
          throw new TurnLeaseLostError(turnId);
        }
        if (turn.lease_token !== leaseToken) throw new TurnLeaseLostError(turnId);
        await client.query(
          `UPDATE agent_turns SET status = $2, outcome_json = $3::jsonb, error_json = $4::jsonb,
             lease_token = NULL, lease_expires_at = NULL, updated_at = now()
           WHERE id = $1`, [turnId, status, outcome ? JSON.stringify(outcome) : null, error ? JSON.stringify(error) : null],
        );
        await client.query("UPDATE projects SET running_turn_id = NULL, updated_at = now() WHERE id = $1 AND running_turn_id = $2", [turn.project_id, turnId]);
        await eventPublisher?.publishTurnEvent({ turnId, projectId: turn.project_id, status });
        return { turnId, status };
      });
    },
  };
}
