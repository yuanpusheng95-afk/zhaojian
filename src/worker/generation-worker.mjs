import { GenerationLeaseLostError } from '../infrastructure/postgres/photo-project-repository.mjs';

const TERMINAL_STATUSES = new Set([
  'completed',
  'partial_failed',
  'failed',
  'cancelled',
]);

export class GenerationWorker {
  #queue;
  #repository;
  #provider;
  #heartbeatIntervalMs;
  #setInterval;
  #clearInterval;

  constructor({
    queue,
    repository,
    provider,
    heartbeatIntervalMs = 10_000,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  }) {
    this.#queue = queue;
    this.#repository = repository;
    this.#provider = provider;
    this.#heartbeatIntervalMs = heartbeatIntervalMs;
    this.#setInterval = setIntervalFn;
    this.#clearInterval = clearIntervalFn;
  }

  async runOnce() {
    const claimed = await this.#queue.claimNext();
    if (!claimed) return null;

    const writeLease = {
      generationId: claimed.id,
      claimToken: claimed.leaseToken,
    };
    try {
      await this.#repository.transitionGeneration({
        ...writeLease,
        to: 'submitted',
      });
      const processing = await this.#repository.transitionGeneration({
        ...writeLease,
        to: 'provider_processing',
      });
      const candidates = await this.#generateWithHeartbeat({
        generation: processing,
        ...writeLease,
      });
      await this.#repository.transitionGeneration({
        ...writeLease,
        to: 'verifying',
      });

      if (!Array.isArray(candidates) || candidates.length === 0) {
        return this.#repository.transitionGeneration({
          ...writeLease,
          to: 'failed',
          error: { message: 'Provider returned no candidates' },
        });
      }

      for (const candidate of candidates) {
        await this.#repository.addCandidate({
          ...writeLease,
          ...candidate,
        });
      }
      return this.#repository.transitionGeneration({
        ...writeLease,
        to: 'completed',
      });
    } catch (error) {
      if (isLeaseLost(error)) {
        return this.#repository.getGeneration(claimed.id);
      }

      const current = await this.#repository.getGeneration(claimed.id);
      if (TERMINAL_STATUSES.has(current.status)) return current;
      try {
        return await this.#repository.transitionGeneration({
          ...writeLease,
          to: 'failed',
          error: { message: error.message },
        });
      } catch (transitionError) {
        if (isLeaseLost(transitionError)) {
          return this.#repository.getGeneration(claimed.id);
        }
        throw transitionError;
      }
    }
  }

  async #generateWithHeartbeat({ generation, generationId, claimToken }) {
    if (
      !claimToken ||
      typeof this.#queue.renewLease !== 'function' ||
      this.#heartbeatIntervalMs <= 0
    ) {
      return this.#provider.generate({ generation });
    }

    let stopped = false;
    let heartbeatError = null;
    let pendingRenewal = Promise.resolve();
    const heartbeat = () => {
      pendingRenewal = pendingRenewal
        .then(async () => {
          if (stopped || heartbeatError) return;
          await this.#queue.renewLease({ generationId, claimToken });
        })
        .catch((error) => {
          heartbeatError = error;
        });
      return pendingRenewal;
    };
    const timer = this.#setInterval(heartbeat, this.#heartbeatIntervalMs);

    let candidates;
    let providerError = null;
    try {
      candidates = await this.#provider.generate({ generation });
    } catch (error) {
      providerError = error;
    } finally {
      stopped = true;
      this.#clearInterval(timer);
      await pendingRenewal;
    }

    if (heartbeatError) throw heartbeatError;
    if (providerError) throw providerError;
    return candidates;
  }
}

function isLeaseLost(error) {
  return (
    error instanceof GenerationLeaseLostError ||
    error?.code === 'GENERATION_LEASE_LOST'
  );
}
