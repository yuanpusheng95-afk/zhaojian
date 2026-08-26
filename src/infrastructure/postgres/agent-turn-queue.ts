import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { and, desc, eq, lte, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";

import { ErrorCode, ProjectNotFoundError } from "@/domain/errors";
import type { TurnEventPublisher } from "@/infrastructure/redis/turn-events";
import * as schema from "@/db/schema";
import { agentTurns, projects } from "@/db/schema";

export class IdempotencyConflictError extends Error {
  code = ErrorCode.IDEMPOTENCY_CONFLICT;
  constructor(projectId: string, idempotencyKey: string) {
    super(`Idempotency key ${idempotencyKey} was reused with a different message in project ${projectId}`);
    this.name = this.constructor.name;
  }
}

export class ProjectBusyError extends Error {
  code = ErrorCode.PROJECT_BUSY;
  constructor(projectId: string, turnId: string) {
    super(`Project ${projectId} already has a running turn: ${turnId}`);
    this.name = this.constructor.name;
  }
}

export class TurnLeaseLostError extends Error {
  code = ErrorCode.TURN_LEASE_LOST;
  constructor(turnId: string) {
    super(`Turn lease is lost: ${turnId}`);
    this.name = this.constructor.name;
  }
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "aborted"]);

export type AgentTurnQueue = ReturnType<typeof createAgentTurnQueue>;
export type ClaimedTurn = NonNullable<Awaited<ReturnType<AgentTurnQueue["claimNextTurn"]>>>;

export function createAgentTurnQueue({ pool, leaseMs = 30_000, eventPublisher }: {
  pool: Pool; leaseMs?: number; eventPublisher?: TurnEventPublisher;
}) {
  if (!pool) throw new TypeError("createAgentTurnQueue requires a pool");
  if (!Number.isInteger(leaseMs) || leaseMs <= 0) {
    throw new TypeError("createAgentTurnQueue requires a positive integer leaseMs");
  }

  type Database = NodePgDatabase<typeof schema>;
  type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
  type Queryable = Database | Transaction;
  const db = drizzle(pool, { schema, casing: "snake_case" });

  async function requireProject(client: Transaction, projectId: string) {
    const result = await client.select().from(projects).where(eq(projects.id, projectId)).for("update");
    const project = result[0];
    if (!project) throw new ProjectNotFoundError(projectId);
    return project;
  }

  async function requireRunningTurnWithLease(client: Queryable, turnId: string, leaseToken: string) {
    const result = await client.select().from(agentTurns).where(eq(agentTurns.id, turnId)).for("update");
    const turn = result[0];
    if (!turn || turn.status !== "running" || turn.leaseToken !== leaseToken) {
      throw new TurnLeaseLostError(turnId);
    }
    return turn;
  }

  return {
    requestTurn({ projectId, userMessage, idempotencyKey }: { projectId: string; userMessage: string; idempotencyKey: string }) {
      if (typeof userMessage !== "string" || userMessage.trim() === "") throw new TypeError("requestTurn requires a non-empty user message");
      if (typeof idempotencyKey !== "string" || idempotencyKey.trim() === "") throw new TypeError("requestTurn requires a non-empty idempotency key");

      return db.transaction(async (client) => {
        const project = await requireProject(client, projectId);

        const idempotency = and(
          eq(agentTurns.projectId, projectId),
          eq(agentTurns.idempotencyKey, idempotencyKey),
        );
        const existingRows = await client.select({
          turnId: agentTurns.id,
          userMessage: agentTurns.userMessage,
        }).from(agentTurns).where(idempotency);
        const existing = existingRows[0];

        if (existing) {
          if (existing.userMessage !== userMessage) throw new IdempotencyConflictError(projectId, idempotencyKey);
          return { turnId: existing.turnId as string, replayed: true };
        }

        if (project.runningTurnId) throw new ProjectBusyError(projectId, project.runningTurnId);

        const insertedRows = await client.insert(agentTurns).values({
          id: `turn_${randomUUID()}`,
          projectId,
          userMessage,
          idempotencyKey,
          status: "queued",
          createdAt: sql`now()`,
          updatedAt: sql`now()`,
        }).onConflictDoNothing({ target: [agentTurns.projectId, agentTurns.idempotencyKey] }).returning({ turnId: agentTurns.id });
        const inserted = insertedRows[0];
        if (inserted) {
          await client.update(projects)
            .set({ runningTurnId: inserted.turnId, updatedAt: sql`now()` })
            .where(eq(projects.id, projectId));
          return { turnId: inserted.turnId as string, replayed: false };
        }

        const racedRows = await client.select({
          turnId: agentTurns.id,
          userMessage: agentTurns.userMessage,
        }).from(agentTurns).where(idempotency);
        const winner = racedRows[0];
        if (!winner || winner.userMessage !== userMessage) throw new IdempotencyConflictError(projectId, idempotencyKey);
        return { turnId: winner.turnId as string, replayed: true };
      });
    },

    listTurns({ projectId }: { projectId: string }) {
      return db.select({
        turnId: agentTurns.id,
        status: agentTurns.status,
        userMessage: agentTurns.userMessage,
        createdAt: agentTurns.createdAt,
        updatedAt: agentTurns.updatedAt,
      }).from(agentTurns)
        .where(eq(agentTurns.projectId, projectId))
        .orderBy(desc(agentTurns.createdAt), desc(agentTurns.id))
        .limit(50);
    },

    claimNextTurn() {
      return db.transaction(async (client) => {
        const queuedRows = await client.select({
          turnId: agentTurns.id,
          projectId: agentTurns.projectId,
          userMessage: agentTurns.userMessage,
        }).from(agentTurns)
          .where(eq(agentTurns.status, "queued"))
          .orderBy(agentTurns.createdAt, agentTurns.id)
          .limit(1)
          .for("update", { skipLocked: true });
        const queued = queuedRows[0];
        if (!queued) return null;

        const leaseToken = randomUUID();
        await client.update(agentTurns).set({
          status: "running",
          leaseToken,
          leaseExpiresAt: sql`now() + make_interval(secs => ${leaseMs / 1000.0})`,
          updatedAt: sql`now()`,
        }).where(eq(agentTurns.id, queued.turnId));
        return { ...queued, leaseToken };
      });
    },

    failExpiredTurns() {
      return db.transaction(async (client) => {
        const expiredRows = await client.select({
          turnId: agentTurns.id,
          projectId: agentTurns.projectId,
        }).from(agentTurns)
          .where(and(
            eq(agentTurns.status, "running"),
            lte(agentTurns.leaseExpiresAt, sql`now()`),
          ))
          .for("update");

        for (const turn of expiredRows) {
          await client.update(agentTurns).set({
            status: "failed",
            errorJson: { code: ErrorCode.WORKER_LEASE_EXPIRED, message: "The turn lease expired before the worker finished." },
            updatedAt: sql`now()`,
          }).where(eq(agentTurns.id, turn.turnId));
          await client.update(projects).set({ runningTurnId: null, updatedAt: sql`now()` })
            .where(and(eq(projects.id, turn.projectId), eq(projects.runningTurnId, turn.turnId)));
        }
        return expiredRows.length;
      });
    },

    renewTurnLease({ turnId, leaseToken }: { turnId: string; leaseToken: string }) {
      return db.transaction(async (client) => {
        await requireRunningTurnWithLease(client, turnId, leaseToken);
        await client.update(agentTurns).set({
          leaseExpiresAt: sql`now() + make_interval(secs => ${leaseMs / 1000.0})`,
          updatedAt: sql`now()`,
        }).where(eq(agentTurns.id, turnId));
      });
    },

    async finishTurn({ turnId, leaseToken, status, outcome = null, error = null }: {
      turnId: string; leaseToken: string; status: string; outcome?: Record<string, unknown> | null; error?: Record<string, unknown> | null;
    }) {
      if (!TERMINAL_STATUSES.has(status)) throw new TypeError("finishTurn status must be completed, failed, or aborted");
      const result = await db.transaction(async (client) => {
        const turnRows = await client.select().from(agentTurns).where(eq(agentTurns.id, turnId)).for("update");
        const turn = turnRows[0];
        if (!turn) throw new TurnLeaseLostError(turnId);
        if (turn.status !== "running") {
          if (turn.status === status && (turn.leaseToken === leaseToken || !turn.leaseToken)) {
            return { turnId, status, projectId: turn.projectId as string, transitioned: false };
          }
          throw new TurnLeaseLostError(turnId);
        }
        if (turn.leaseToken !== leaseToken) throw new TurnLeaseLostError(turnId);

        await client.update(agentTurns).set({
          status,
          outcomeJson: outcome ?? null,
          errorJson: error ?? null,
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: sql`now()`,
        }).where(eq(agentTurns.id, turnId));
        await client.update(projects)
          .set({ runningTurnId: null, updatedAt: sql`now()` })
          .where(and(eq(projects.id, turn.projectId), eq(projects.runningTurnId, turnId)));
        return { turnId, status, projectId: turn.projectId as string, transitioned: true };
      });

      if (result.transitioned) {
        await eventPublisher?.publishTurnEvent(result).catch(() => undefined);
      }

      return result;
    },
  };
}
