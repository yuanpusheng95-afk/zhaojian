export class PostgresGenerationQueue {
  #pool;
  #repository;
  #now;

  constructor({
    pool,
    repository,
    now = () => new Date().toISOString(),
  }) {
    this.#pool = pool;
    this.#repository = repository;
    this.#now = now;
  }

  async claimNext() {
    const client = await this.#pool.connect();
    let generationId = null;
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `WITH next_job AS (
           SELECT id
           FROM generation_jobs
           WHERE status = 'queued'
           ORDER BY created_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE generation_jobs AS job
         SET status = 'preparing', updated_at = $1
         FROM next_job
         WHERE job.id = next_job.id
         RETURNING job.id`,
        [this.#now()],
      );
      generationId = result.rows[0]?.id ?? null;
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    if (!generationId) return null;
    return this.#repository.getGeneration(generationId);
  }
}
