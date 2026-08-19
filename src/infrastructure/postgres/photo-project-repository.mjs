import { createHash, randomUUID } from 'node:crypto';

import {
  CandidateSelectionError,
  GenerationNotFoundError,
  GenerationTransitionError,
  IdempotencyConflictError,
  InvalidGenerationRequestError,
  ProjectBusyError,
  ProjectNotFoundError,
  RevisionConflictError,
} from '../../domain/photo-project-service.mjs';
import {
  GENERATION_TRANSITIONS,
  SELECTABLE_GENERATION_STATUSES,
  TERMINAL_GENERATION_STATUSES,
} from '../../domain/generation-lifecycle.mjs';
import { applyPhotoStatePatch } from '../../domain/photo-state.mjs';

export class GenerationLeaseLostError extends Error {
  constructor(generationId) {
    super(`Generation lease lost: ${generationId}`);
    this.name = 'GenerationLeaseLostError';
    this.code = 'GENERATION_LEASE_LOST';
  }
}

export class ProviderJobConflictError extends Error {
  constructor(generationId) {
    super(`Generation already has a different provider job: ${generationId}`);
    this.name = 'ProviderJobConflictError';
    this.code = 'PROVIDER_JOB_CONFLICT';
  }
}

export class PostgresPhotoProjectRepository {
  #pool;
  #idFactory;
  #now;

  constructor({
    pool,
    idFactory = (prefix) => `${prefix}_${randomUUID()}`,
    now = () => new Date().toISOString(),
  }) {
    this.#pool = pool;
    this.#idFactory = idFactory;
    this.#now = now;
  }

  async createProject({ projectId, name, initialState, anchorAssetId = null }) {
    const id = projectId ?? this.#idFactory('project');
    const revisionId = this.#idFactory('revision');
    const now = this.#now();
    const state = applyPhotoStatePatch(initialState, {
      modify: [],
      preserve: [],
    });

    return this.#transaction(async (client) => {
      if (anchorAssetId) {
        await client.query(
          `INSERT INTO assets (id, kind, created_at)
           VALUES ($1, 'source', $2)
           ON CONFLICT (id) DO NOTHING`,
          [anchorAssetId, now],
        );
      }
      await client.query(
        `INSERT INTO projects
          (id, name, active_revision_id, running_generation_id, created_at, updated_at)
         VALUES ($1, $2, NULL, NULL, $3, $3)`,
        [id, name, now],
      );
      await client.query(
        `INSERT INTO photo_revisions
          (id, project_id, parent_revision_id, state_json, anchor_asset_id,
           source_generation_id, created_at)
         VALUES ($1, $2, NULL, $3, $4, NULL, $5)`,
        [revisionId, id, state, anchorAssetId, now],
      );
      const result = await client.query(
        `UPDATE projects
         SET active_revision_id = $2
         WHERE id = $1
         RETURNING *`,
        [id, revisionId],
      );
      return mapProject(result.rows[0]);
    });
  }

  async requestGeneration({
    projectId,
    baseRevisionId,
    idempotencyKey,
    patch,
    operation = 'edit',
  }) {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
      throw new InvalidGenerationRequestError(
        'Generation request requires a non-empty idempotency key',
      );
    }

    const fingerprint = requestFingerprint({
      baseRevisionId,
      operation,
      patch,
    });

    return this.#transaction(async (client) => {
      const project = await this.#requireProject(client, projectId, {
        forUpdate: true,
      });
      const idempotency = await client.query(
        `SELECT request_fingerprint, generation_id
         FROM idempotency_requests
         WHERE project_id = $1 AND idempotency_key = $2`,
        [projectId, idempotencyKey],
      );
      if (idempotency.rowCount > 0) {
        const existing = idempotency.rows[0];
        if (existing.request_fingerprint !== fingerprint) {
          throw new IdempotencyConflictError(projectId, idempotencyKey);
        }
        return this.#requireGeneration(client, existing.generation_id);
      }

      if (project.runningGenerationId) {
        throw new ProjectBusyError(projectId, project.runningGenerationId);
      }
      if (project.activeRevisionId !== baseRevisionId) {
        throw new RevisionConflictError({
          projectId,
          expectedRevisionId: baseRevisionId,
          actualRevisionId: project.activeRevisionId,
        });
      }

      const revision = await this.#requireRevision(client, baseRevisionId);
      const proposedState = applyPhotoStatePatch(revision.state, patch);
      const generationId = this.#idFactory('generation');
      const now = this.#now();

      await client.query(
        `INSERT INTO generation_jobs
          (id, project_id, input_revision_id, operation, idempotency_key,
           patch_json, proposed_state_json, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8, $8)`,
        [
          generationId,
          projectId,
          baseRevisionId,
          operation,
          idempotencyKey,
          patch,
          proposedState,
          now,
        ],
      );
      await client.query(
        `INSERT INTO idempotency_requests
          (project_id, idempotency_key, request_fingerprint, generation_id, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [projectId, idempotencyKey, fingerprint, generationId, now],
      );
      await client.query(
        `UPDATE projects
         SET running_generation_id = $2, updated_at = $3
         WHERE id = $1`,
        [projectId, generationId, now],
      );

      return this.#requireGeneration(client, generationId);
    });
  }

  async transitionGeneration({
    generationId,
    to,
    error = null,
    claimToken,
  }) {
    return this.#transaction(async (client) => {
      const generation = await this.#requireGeneration(client, generationId, {
        forUpdate: true,
        includeLease: true,
      });
      const projectId = generation.projectId;
      await this.#requireProject(client, projectId, { forUpdate: true });
      requireLease(generation, claimToken);
      const allowed = GENERATION_TRANSITIONS.get(generation.status);
      if (!allowed?.has(to)) {
        throw new GenerationTransitionError(
          generationId,
          generation.status,
          to,
        );
      }
      if (to === 'completed' && generation.candidates.length === 0) {
        throw new GenerationTransitionError(
          generationId,
          generation.status,
          to,
        );
      }

      const now = this.#now();
      await client.query(
        `UPDATE generation_jobs
         SET status = $2,
             last_error_json = $3,
             updated_at = $4,
             claim_token = CASE WHEN $5 THEN NULL ELSE claim_token END,
             claimed_at = CASE WHEN $5 THEN NULL ELSE claimed_at END,
             lease_expires_at = CASE WHEN $5 THEN NULL ELSE lease_expires_at END
         WHERE id = $1`,
        [generationId, to, error, now, TERMINAL_GENERATION_STATUSES.has(to)],
      );
      if (TERMINAL_GENERATION_STATUSES.has(to)) {
        await client.query(
          `UPDATE projects
           SET running_generation_id = NULL, updated_at = $3
           WHERE id = $1 AND running_generation_id = $2`,
          [projectId, generationId, now],
        );
      }
      return this.#requireGeneration(client, generationId);
    });
  }

  async recordProviderJob({
    generationId,
    claimToken,
    providerName,
    providerJobId,
  }) {
    return this.#transaction(async (client) => {
      const generation = await this.#requireGeneration(client, generationId, {
        forUpdate: true,
        includeLease: true,
        includeProvider: true,
      });
      requireLease(generation, claimToken);
      if (generation.status !== 'submitted') {
        throw new GenerationTransitionError(
          generationId,
          generation.status,
          'record_provider_job',
        );
      }
      if (generation.providerJobId) {
        if (
          generation.providerName === providerName &&
          generation.providerJobId === providerJobId
        ) {
          return providerJobFromGeneration(generation);
        }
        throw new ProviderJobConflictError(generationId);
      }

      const now = this.#now();
      const result = await client.query(
        `UPDATE generation_jobs
         SET provider_name = $2,
             provider_job_id = $3,
             provider_submitted_at = $4,
             updated_at = $4
         WHERE id = $1
         RETURNING provider_name, provider_job_id, provider_submitted_at`,
        [generationId, providerName, providerJobId, now],
      );
      return mapProviderJob(result.rows[0]);
    });
  }

  async addCandidate({
    generationId,
    candidateId,
    assetId,
    verification = {},
    claimToken,
  }) {
    return this.#transaction(async (client) => {
      const generation = await this.#requireGeneration(client, generationId, {
        forUpdate: true,
        includeLease: true,
      });
      requireLease(generation, claimToken);
      if (generation.status !== 'verifying') {
        throw new GenerationTransitionError(
          generationId,
          generation.status,
          'add_candidate',
        );
      }

      const id = candidateId ?? this.#idFactory('candidate');
      const now = this.#now();
      await client.query(
        `INSERT INTO assets (id, kind, created_at)
         VALUES ($1, 'generated', $2)
         ON CONFLICT (id) DO NOTHING`,
        [assetId, now],
      );
      try {
        const result = await client.query(
          `INSERT INTO generation_outputs
            (id, generation_id, asset_id, verification_json, created_at)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [id, generationId, assetId, verification, now],
        );
        await client.query(
          'UPDATE generation_jobs SET updated_at = $2 WHERE id = $1',
          [generationId, now],
        );
        return mapCandidate(result.rows[0]);
      } catch (error) {
        if (error.code === '23505') {
          throw new CandidateSelectionError(`Candidate already exists: ${id}`);
        }
        throw error;
      }
    });
  }

  async selectCandidate({ projectId, generationId, candidateId }) {
    return this.#transaction(async (client) => {
      const generation = await this.#requireGeneration(client, generationId, {
        forUpdate: true,
      });
      const project = await this.#requireProject(client, projectId, {
        forUpdate: true,
      });
      if (generation.projectId !== projectId) {
        throw new CandidateSelectionError(
          `Generation ${generationId} does not belong to project ${projectId}`,
        );
      }
      if (generation.selectedCandidateId) {
        if (generation.selectedCandidateId !== candidateId) {
          throw new CandidateSelectionError(
            `Generation ${generationId} already selected candidate ${generation.selectedCandidateId}`,
          );
        }
        return this.#requireRevision(client, generation.selectedRevisionId);
      }
      if (
        project.runningGenerationId &&
        project.runningGenerationId !== generationId
      ) {
        throw new ProjectBusyError(projectId, project.runningGenerationId);
      }
      if (!SELECTABLE_GENERATION_STATUSES.has(generation.status)) {
        throw new CandidateSelectionError(
          `Generation ${generationId} is not selectable in status ${generation.status}`,
        );
      }
      if (project.activeRevisionId !== generation.inputRevisionId) {
        throw new RevisionConflictError({
          projectId,
          expectedRevisionId: generation.inputRevisionId,
          actualRevisionId: project.activeRevisionId,
        });
      }

      const candidateResult = await client.query(
        `SELECT * FROM generation_outputs
         WHERE id = $1 AND generation_id = $2`,
        [candidateId, generationId],
      );
      if (candidateResult.rowCount === 0) {
        throw new CandidateSelectionError(
          `Candidate ${candidateId} does not belong to generation ${generationId}`,
        );
      }

      const candidate = mapCandidate(candidateResult.rows[0]);
      const revisionId = this.#idFactory('revision');
      const now = this.#now();
      const revisionResult = await client.query(
        `INSERT INTO photo_revisions
          (id, project_id, parent_revision_id, state_json, anchor_asset_id,
           source_generation_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          revisionId,
          projectId,
          generation.inputRevisionId,
          generation.proposedState,
          candidate.assetId,
          generationId,
          now,
        ],
      );
      await client.query(
        `UPDATE generation_jobs
         SET selected_candidate_id = $2, selected_revision_id = $3, updated_at = $4
         WHERE id = $1`,
        [generationId, candidateId, revisionId, now],
      );
      await client.query(
        `UPDATE projects
         SET active_revision_id = $2, updated_at = $3
         WHERE id = $1`,
        [projectId, revisionId, now],
      );
      return mapRevision(revisionResult.rows[0]);
    });
  }

  async getProject(projectId) {
    return this.#requireProject(this.#pool, projectId);
  }

  async getGeneration(generationId) {
    return this.#requireGeneration(this.#pool, generationId);
  }

  async getRevision(revisionId) {
    return this.#requireRevision(this.#pool, revisionId);
  }

  async listRevisions(projectId) {
    await this.#requireProject(this.#pool, projectId);
    const result = await this.#pool.query(
      `SELECT * FROM photo_revisions
       WHERE project_id = $1
       ORDER BY created_at, id`,
      [projectId],
    );
    return result.rows.map(mapRevision);
  }

  async listGenerations(projectId) {
    await this.#requireProject(this.#pool, projectId);
    const result = await this.#pool.query(
      `SELECT id FROM generation_jobs
       WHERE project_id = $1
       ORDER BY created_at, id`,
      [projectId],
    );
    return Promise.all(
      result.rows.map(({ id }) => this.#requireGeneration(this.#pool, id)),
    );
  }

  async #requireProject(database, projectId, { forUpdate = false } = {}) {
    const result = await database.query(
      `SELECT * FROM projects WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [projectId],
    );
    if (result.rowCount === 0) throw new ProjectNotFoundError(projectId);
    return mapProject(result.rows[0]);
  }

  async #requireGeneration(
    database,
    generationId,
    {
      forUpdate = false,
      includeLease = false,
      includeProvider = false,
    } = {},
  ) {
    const result = await database.query(
      `SELECT * FROM generation_jobs WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [generationId],
    );
    if (result.rowCount === 0) {
      throw new GenerationNotFoundError(generationId);
    }
    const candidates = await database.query(
      `SELECT * FROM generation_outputs
       WHERE generation_id = $1
       ORDER BY created_at, id`,
      [generationId],
    );
    return mapGeneration(result.rows[0], candidates.rows, {
      includeLease,
      includeProvider,
    });
  }

  async #requireRevision(database, revisionId) {
    const result = await database.query(
      'SELECT * FROM photo_revisions WHERE id = $1',
      [revisionId],
    );
    if (result.rowCount === 0) {
      const error = new Error(`Revision not found: ${revisionId}`);
      error.code = 'REVISION_NOT_FOUND';
      throw error;
    }
    return mapRevision(result.rows[0]);
  }

  async #transaction(callback) {
    const client = await this.#pool.connect();
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
}

function mapProject(row) {
  return {
    id: row.id,
    name: row.name,
    activeRevisionId: row.active_revision_id,
    runningGenerationId: row.running_generation_id,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapRevision(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    parentRevisionId: row.parent_revision_id,
    state: row.state_json,
    anchorAssetId: row.anchor_asset_id,
    sourceGenerationId: row.source_generation_id,
    createdAt: toIso(row.created_at),
  };
}

function mapGeneration(
  row,
  candidateRows,
  { includeLease = false, includeProvider = false } = {},
) {
  const generation = {
    id: row.id,
    projectId: row.project_id,
    inputRevisionId: row.input_revision_id,
    operation: row.operation,
    idempotencyKey: row.idempotency_key,
    patch: row.patch_json,
    proposedState: row.proposed_state_json,
    status: row.status,
    candidates: candidateRows.map(mapCandidate),
    selectedCandidateId: row.selected_candidate_id,
    selectedRevisionId: row.selected_revision_id,
    error: row.last_error_json,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
  if (includeLease) {
    generation.leaseToken = row.claim_token;
    generation.claimedAt = toIso(row.claimed_at);
    generation.leaseExpiresAt = toIso(row.lease_expires_at);
    generation.attemptCount = row.attempt_count;
  }
  if (includeProvider) {
    generation.providerName = row.provider_name;
    generation.providerJobId = row.provider_job_id;
    generation.providerSubmittedAt = toIso(row.provider_submitted_at);
  }
  return generation;
}

function providerJobFromGeneration(generation) {
  return {
    providerName: generation.providerName,
    providerJobId: generation.providerJobId,
    providerSubmittedAt: generation.providerSubmittedAt,
  };
}

function mapProviderJob(row) {
  return {
    providerName: row.provider_name,
    providerJobId: row.provider_job_id,
    providerSubmittedAt: toIso(row.provider_submitted_at),
  };
}

function requireLease(generation, claimToken) {
  if (generation.leaseToken && generation.leaseToken !== claimToken) {
    throw new GenerationLeaseLostError(generation.id);
  }
}

function mapCandidate(row) {
  return {
    id: row.id,
    assetId: row.asset_id,
    verification: row.verification_json,
    createdAt: toIso(row.created_at),
  };
}

function toIso(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function requestFingerprint(value) {
  return createHash('sha256')
    .update(JSON.stringify(sortObject(value)))
    .digest('hex');
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortObject(value[key])]),
  );
}
