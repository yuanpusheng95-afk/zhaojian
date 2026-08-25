import { ErrorCode } from "../domain/errors.js";
import type { AgentTurnQueue } from "../infrastructure/postgres/agent-turn-queue.js";
import type { AgentTurnResult } from "../agent/agent-runner.js";

export interface WorkerConfig {
  heartbeatMs: number;
}

type TimerSet = {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
};

export interface ClaimedTurn {
  turnId: string;
  projectId: string;
  userMessage: string;
  leaseToken: string;
}

export type AgentTurnExecution = AgentTurnResult & { outcome?: Record<string, unknown> | null };

type TurnQueue = Pick<AgentTurnQueue, "failExpiredTurns" | "claimNextTurn" | "renewTurnLease" | "finishTurn">;
type RunTurn = (turn: ClaimedTurn, signal: AbortSignal) => Promise<AgentTurnExecution | null>;

export class AgentTurnWorker {
  #queue: TurnQueue;
  #runTurn: RunTurn;
  #config: WorkerConfig;
  #timers: TimerSet;
  #running = new Set<Promise<unknown>>();
  #stopped = false;

  constructor({ queue, runTurn, config, timers = { setTimeout, clearTimeout } }: {
    queue: TurnQueue;
    runTurn: RunTurn;
    config: WorkerConfig;
    timers?: TimerSet;
  }) {
    if (!queue) throw new TypeError("createAgentTurnWorker requires a queue");
    if (typeof runTurn !== "function") throw new TypeError("createAgentTurnWorker requires runTurn");
    if (!config) throw new TypeError("createAgentTurnWorker requires config");
    this.#queue = queue;
    this.#runTurn = runTurn;
    this.#config = config;
    this.#timers = timers;
  }

  get inFlightCount() {
    return this.#running.size;
  }

  get stopped() {
    return this.#stopped;
  }

  stop() {
    this.#stopped = true;
  }

  async runOnce(): Promise<AgentTurnExecution | null> {
    await this.#queue.failExpiredTurns();
    if (this.#stopped) return null;
    const turn = await this.#queue.claimNextTurn();
    if (!turn) return null;

    const execution = this.#execute(turn).finally(() => {
      this.#running.delete(execution);
    });
    this.#running.add(execution);
    return execution;
  }

  async waitUntilIdle() {
    while (this.#running.size > 0) {
      await Promise.allSettled([...this.#running]);
    }
  }

  async #heartbeat(turn: ClaimedTurn, signal: AbortSignal): Promise<boolean> {
    const { heartbeatMs = 10_000 } = this.#config;
    while (!signal.aborted) {
      await new Promise((resolve) => this.#timers.setTimeout(resolve, heartbeatMs));
      if (signal.aborted) return true;
      try {
        await this.#queue.renewTurnLease({
          turnId: turn.turnId,
          leaseToken: turn.leaseToken,
        });
      } catch (error) {
        if ((error as { code?: string })?.code === ErrorCode.TURN_LEASE_LOST) return false;
        throw error;
      }
    }
    return true;
  }

  async #execute(turn: ClaimedTurn): Promise<AgentTurnExecution | null> {
    let heartbeatLost = false;
    const heartbeatController = new AbortController();
    const heartbeat = this.#heartbeat(turn, heartbeatController.signal)
      .catch((error) => {
        if ((error as { code?: string })?.code === ErrorCode.TURN_LEASE_LOST) {
          heartbeatLost = true;
          return false;
        }
        throw error;
      })
      .finally(() => {
        if (!heartbeatLost) heartbeatController.abort();
      });

    try {
      const result = await Promise.race([
        this.#runTurn(turn, heartbeatController.signal),
        heartbeat.then((alive) => {
          if (alive) return new Promise(() => {});
          heartbeatLost = true;
          return null;
        }),
      ]);
      if (heartbeatLost) return null;
      const execution: AgentTurnExecution = result as AgentTurnExecution;
      const status = execution.fatal ? "failed" : execution.kind ?? "completed";
      await this.#queue.finishTurn({
        turnId: turn.turnId,
        leaseToken: turn.leaseToken,
        status,
        outcome: status === "completed" ? execution.outcome ?? null : null,
        error: status === "failed"
          ? execution.fatal ?? execution.error ?? { code: "AGENT_TURN_FAILED", message: "Agent turn failed." }
          : status === "aborted"
            ? execution.error ?? { code: "TURN_ABORTED", message: "Agent turn aborted." }
            : null,
      });
      return execution;
    } catch (error) {
      if (!heartbeatLost) {
        await this.#queue.finishTurn({
          turnId: turn.turnId,
          leaseToken: turn.leaseToken,
          status: "failed",
          error: { code: "AGENT_RUN_FAILED", message: (error as Error)?.message ?? String(error) },
        });
      }
      throw error;
    } finally {
      heartbeatController.abort();
      await heartbeat.catch(() => {});
    }
  }
}

export function createAgentTurnWorker(options: ConstructorParameters<typeof AgentTurnWorker>[0]) {
  return new AgentTurnWorker(options);
}
