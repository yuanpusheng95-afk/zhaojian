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

  constructor({ queue, repository, provider }) {
    this.#queue = queue;
    this.#repository = repository;
    this.#provider = provider;
  }

  async runOnce() {
    const claimed = await this.#queue.claimNext();
    if (!claimed) return null;

    try {
      await this.#repository.transitionGeneration({
        generationId: claimed.id,
        to: 'submitted',
      });
      const processing = await this.#repository.transitionGeneration({
        generationId: claimed.id,
        to: 'provider_processing',
      });
      const candidates = await this.#provider.generate({
        generation: processing,
      });
      await this.#repository.transitionGeneration({
        generationId: claimed.id,
        to: 'verifying',
      });

      if (!Array.isArray(candidates) || candidates.length === 0) {
        return this.#repository.transitionGeneration({
          generationId: claimed.id,
          to: 'failed',
          error: { message: 'Provider returned no candidates' },
        });
      }

      for (const candidate of candidates) {
        await this.#repository.addCandidate({
          generationId: claimed.id,
          ...candidate,
        });
      }
      return this.#repository.transitionGeneration({
        generationId: claimed.id,
        to: 'completed',
      });
    } catch (error) {
      const current = await this.#repository.getGeneration(claimed.id);
      if (TERMINAL_STATUSES.has(current.status)) return current;
      return this.#repository.transitionGeneration({
        generationId: claimed.id,
        to: 'failed',
        error: { message: error.message },
      });
    }
  }
}
