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
  #imageProvider;
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
    requireImageGenerationProvider(provider);
    this.#queue = queue;
    this.#repository = repository;
    this.#imageProvider = provider;
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
      const submitted = await this.#repository.transitionGeneration({
        ...writeLease,
        to: 'submitted',
      });
      const candidates = await this.#withHeartbeat(writeLease, async () => {
        const providerJobId = await this.#ensureProviderJob({
          claimed,
          generation: submitted,
          writeLease,
        });
        const processing = await this.#repository.transitionGeneration({
          ...writeLease,
          to: 'provider_processing',
        });
        return this.#imageProvider.waitForResult({
          generation: processing,
          jobId: providerJobId,
        });
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

  async #ensureProviderJob({ claimed, generation, writeLease }) {
    if (claimed.providerJobId) {
      if (claimed.providerName !== this.#imageProvider.providerName) {
        throw new Error(
          `Provider job ${claimed.providerJobId} belongs to ${claimed.providerName}, not ${this.#imageProvider.providerName}`,
        );
      }
      if (
        claimed.providerModel != null &&
        claimed.providerModel !== this.#imageProvider.modelName
      ) {
        throw new Error(
          `Provider job ${claimed.providerJobId} belongs to model ${claimed.providerModel}, not ${this.#imageProvider.modelName}`,
        );
      }
      return claimed.providerJobId;
    }

    const submission = await this.#imageProvider.submit({
      generation,
      idempotencyKey: claimed.id,
    });
    if (typeof submission?.jobId !== 'string' || submission.jobId === '') {
      throw new Error(
        `Provider ${this.#imageProvider.providerName} returned no job ID`,
      );
    }
    await this.#repository.recordProviderJob({
      ...writeLease,
      providerName: this.#imageProvider.providerName,
      providerModel: this.#imageProvider.modelName,
      providerJobId: submission.jobId,
    });
    return submission.jobId;
  }

  async #withHeartbeat({ generationId, claimToken }, operation) {
    if (
      !claimToken ||
      typeof this.#queue.renewLease !== 'function' ||
      this.#heartbeatIntervalMs <= 0
    ) {
      return operation();
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

    let result;
    let operationError = null;
    try {
      result = await operation();
    } catch (error) {
      operationError = error;
    } finally {
      stopped = true;
      this.#clearInterval(timer);
      await pendingRenewal;
    }

    if (heartbeatError) throw heartbeatError;
    if (operationError) throw operationError;
    return result;
  }
}

function requireImageGenerationProvider(provider) {
  if (
    provider?.capability !== 'image_generation' ||
    typeof provider.providerName !== 'string' ||
    provider.providerName.trim() === '' ||
    typeof provider.modelName !== 'string' ||
    provider.modelName.trim() === '' ||
    typeof provider.submit !== 'function' ||
    typeof provider.waitForResult !== 'function'
  ) {
    throw new Error(
      'Image generation provider must implement capability, providerName, modelName, submit(), and waitForResult()',
    );
  }
}

function isLeaseLost(error) {
  return (
    error instanceof GenerationLeaseLostError ||
    error?.code === 'GENERATION_LEASE_LOST'
  );
}
