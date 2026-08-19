import { randomUUID } from 'node:crypto';

import { GenerationLeaseLostError } from './photo-project-repository.mjs';

const ACTIVE_STATUSES = [
  'preparing',
  'submitted',
  'provider_processing',
  'verifying',
];

export class PostgresGenerationQueue {
  #pool;
  #repository;
  #now;
  #leaseDurationMs;
  #maxAttempts;
  #tokenFactory;

  constructor({
    pool,
    repository,
    now = () => new Date().toISOString(),
    leaseDurationMs = 30_000,
    maxAttempts = 3,
    tokenFactory = () => randomUUID(),
  }) {
    this.#pool = pool;
    this.#repository = repository;
    this.#now = now;
    this.#leaseDurationMs = leaseDurationMs;
    this.#maxAttempts = maxAttempts;
    this.#tokenFactory = tokenFactory;
  }

  async claimNext() {
    const client = await this.#pool.connect();
    let lease = null;
    try {
      await client.query('BEGIN');
      while (!lease) {
        const now = this.#now();
        const result = await client.query(
          `SELECT id, project_id, status, attempt_count,
                  provider_name, provider_model,
                  provider_job_id, provider_submitted_at
           FROM generation_jobs
           WHERE status = 'queued'
              OR (
                status = ANY($2::text[])
                AND lease_expires_at <= $1
              )
           ORDER BY created_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT 1`,
          [now, ACTIVE_STATUSES],
        );
        const job = result.rows[0];
        if (!job) break;

        if (job.status !== 'queued' && job.attempt_count >= this.#maxAttempts) {
          await this.#failExhausted(client, job, now);
          continue;
        }

        if (job.status !== 'queued') {
          await client.query(
            'DELETE FROM generation_outputs WHERE generation_id = $1',
            [job.id],
          );
        }

        const claimToken = this.#tokenFactory();
        const leaseExpiresAt = addMilliseconds(now, this.#leaseDurationMs);
        const claimed = await client.query(
          `UPDATE generation_jobs
           SET status = 'preparing',
               claim_token = $2,
               claimed_at = $3,
               lease_expires_at = $4,
               attempt_count = attempt_count + 1,
               last_error_json = NULL,
               updated_at = $3
           WHERE id = $1
           RETURNING attempt_count`,
          [job.id, claimToken, now, leaseExpiresAt],
        );
        lease = {
          generationId: job.id,
          leaseToken: claimToken,
          leaseExpiresAt,
          attemptCount: claimed.rows[0].attempt_count,
          providerName: job.provider_name,
          providerModel: job.provider_model,
          providerJobId: job.provider_job_id,
          providerSubmittedAt: toIso(job.provider_submitted_at),
        };
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    if (!lease) return null;
    const generation = await this.#repository.getGeneration(lease.generationId);
    const { generationId, ...claim } = lease;
    return { ...generation, ...claim };
  }

  async renewLease({ generationId, claimToken }) {
    const now = this.#now();
    const leaseExpiresAt = addMilliseconds(now, this.#leaseDurationMs);
    const result = await this.#pool.query(
      `UPDATE generation_jobs
       SET lease_expires_at = $3, updated_at = $2
       WHERE id = $1
         AND claim_token = $4
         AND status = ANY($5::text[])
       RETURNING attempt_count`,
      [generationId, now, leaseExpiresAt, claimToken, ACTIVE_STATUSES],
    );
    if (result.rowCount === 0) {
      throw new GenerationLeaseLostError(generationId);
    }
    return {
      generationId,
      leaseToken: claimToken,
      leaseExpiresAt,
      attemptCount: result.rows[0].attempt_count,
    };
  }

  async #failExhausted(client, job, now) {
    await client.query(
      `UPDATE generation_jobs
       SET status = 'failed',
           last_error_json = $2,
           claim_token = NULL,
           claimed_at = NULL,
           lease_expires_at = NULL,
           updated_at = $3
       WHERE id = $1`,
      [
        job.id,
        { message: `Generation lease exhausted after ${job.attempt_count} attempts` },
        now,
      ],
    );
    await client.query(
      `UPDATE projects
       SET running_generation_id = NULL, updated_at = $3
       WHERE id = $1 AND running_generation_id = $2`,
      [job.project_id, job.id, now],
    );
  }
}

function addMilliseconds(isoTime, durationMs) {
  return new Date(new Date(isoTime).getTime() + durationMs).toISOString();
}

function toIso(value) {
  return value instanceof Date ? value.toISOString() : value;
}
