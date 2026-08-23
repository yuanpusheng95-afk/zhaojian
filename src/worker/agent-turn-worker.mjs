export class AgentTurnWorker {
  #queue;
  #runTurn;
  #config;
  #timers;
  #running = new Set();
  #stopped = false;

  constructor({ queue, runTurn, config, timers = { setTimeout, clearTimeout } }) {
    if (!queue) throw new TypeError('createAgentTurnWorker requires a queue');
    if (typeof runTurn !== 'function') throw new TypeError('createAgentTurnWorker requires runTurn');
    if (!config) throw new TypeError('createAgentTurnWorker requires config');
    this.#queue = queue;
    this.#runTurn = runTurn;
    this.#config = config;
    this.#timers = timers;
  }

  get inFlightCount() {
    return this.#running.size;
  }

  stop() {
    this.#stopped = true;
  }

  get stopped() {
    return this.#stopped;
  }

  async runOnce() {
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

  async #heartbeat(turn, signal) {
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
        if (error?.code === 'TURN_LEASE_LOST') return false;
        throw error;
      }
    }
    return true;
  }

  async #execute(turn) {
    let heartbeatLost = false;
    const heartbeatController = new AbortController();
    const heartbeat = this.#heartbeat(turn, heartbeatController.signal)
      .catch((error) => {
        if (error?.code === 'TURN_LEASE_LOST') {
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
      const status = result?.fatal ? 'failed' : result?.kind ?? 'completed';
      await this.#queue.finishTurn({
        turnId: turn.turnId,
        leaseToken: turn.leaseToken,
        status,
        outcome: status === 'completed' ? result?.outcome ?? null : null,
        error: status === 'failed'
          ? result?.fatal ?? { code: 'AGENT_TURN_FAILED', message: 'Agent turn failed.' }
          : status === 'aborted'
            ? result?.error ?? { code: 'TURN_ABORTED', message: 'Agent turn aborted.' }
            : null,
      });
      return result;
    } catch (error) {
      if (heartbeatLost) return null;
      if (!heartbeatLost) {
        await this.#queue.finishTurn({
          turnId: turn.turnId,
          leaseToken: turn.leaseToken,
          status: 'failed',
          error: { code: 'AGENT_RUN_FAILED', message: error?.message ?? String(error) },
        });
      }
      throw error;
    } finally {
      heartbeatController.abort();
      await heartbeat.catch(() => {});
    }
  }
}

export function createAgentTurnWorker(options) {
  return new AgentTurnWorker(options);
}
