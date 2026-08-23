import { randomUUID } from 'node:crypto';

import {
  AssetNotFoundError,
  CandidateSelectionError,
  GenerationNotFoundError,
  InvalidGenerationRequestError,
  ProjectNotFoundError,
  RevisionConflictError,
  TurnNotFoundError,
} from '../../domain/photo-project-service.mjs';
import { SELECTABLE_GENERATION_STATUSES } from '../../domain/generation-lifecycle.mjs';
import { applyPhotoStatePatch } from '../../domain/photo-state.mjs';

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

  async createProject({
    projectId,
    name,
    initialState,
    anchorAsset = null,
    ownerId = 'dev',
  }) {
    const id = projectId ?? this.#idFactory('project');
    const revisionId = this.#idFactory('revision');
    const now = this.#now();
    const state = applyPhotoStatePatch(initialState, {
      modify: [],
      preserve: [],
    });

    return this.#transaction(async (client) => {
      if (anchorAsset) {
        await this.#upsertAsset(client, {
          id: anchorAsset.assetId,
          kind: 'source',
          uri: anchorAsset.uri,
          metadata: anchorAsset.metadata ?? {},
          createdAt: now,
        });
      }
      await client.query(
        `INSERT INTO projects
          (id, name, active_revision_id, owner_id, created_at, updated_at)
         VALUES ($1, $2, NULL, $3, $4, $4)`,
        [id, name, ownerId, now],
      );
      await client.query(
        `INSERT INTO photo_revisions
          (id, project_id, parent_revision_id, state_json, anchor_asset_id,
           source_generation_id, created_at)
         VALUES ($1, $2, NULL, $3, $4, NULL, $5)`,
        [revisionId, id, state, anchorAsset?.assetId ?? null, now],
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

  async recordGeneration({
    projectId,
    turnId,
    baseRevisionId,
    inputAssetId,
    patch,
    renderPrompt = null,
    outcome,
  }) {
    if (typeof turnId !== 'string' || turnId.trim() === '') {
      throw new InvalidGenerationRequestError(
        'Generation requires a non-empty turn id',
      );
    }

    return this.#transaction(async (client) => {
      const project = await this.#requireProject(client, projectId, {
        forUpdate: true,
      });
      if (project.activeRevisionId !== baseRevisionId) {
        throw new RevisionConflictError({
          projectId,
          expectedRevisionId: baseRevisionId,
          actualRevisionId: project.activeRevisionId,
        });
      }

      const turn = await client.query(
        `SELECT id FROM agent_turns
         WHERE id = $1 AND project_id = $2`,
        [turnId, projectId],
      );
      if (turn.rowCount === 0) {
        throw new TurnNotFoundError(projectId, turnId);
      }

      const inputAsset = await client.query(
        'SELECT id FROM assets WHERE id = $1',
        [inputAssetId],
      );
      if (inputAsset.rowCount === 0) {
        throw new AssetNotFoundError(inputAssetId);
      }

      const revision = await this.#requireRevision(client, baseRevisionId);
      const proposedState = applyPhotoStatePatch(revision.state, patch);
      const generationId = this.#idFactory('generation');
      const now = this.#now();
      const completed = outcome?.kind === 'completed';
      const failed = outcome?.kind === 'failed';
      if (!completed && !failed) {
        throw new InvalidGenerationRequestError(
          'Generation outcome must be completed or failed',
        );
      }

      await client.query(
        `INSERT INTO generations
          (id, project_id, input_revision_id, patch_json,
           proposed_state_json, status, input_asset_id, turn_id,
           metadata_json, last_error_json, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
        [
          generationId,
          projectId,
          baseRevisionId,
          patch,
          proposedState,
          completed ? 'completed' : 'failed',
          inputAssetId,
          turnId,
          { renderPrompt },
          failed ? outcome.error ?? null : null,
          now,
        ],
      );

      if (completed) {
        const candidateId = outcome.candidate.candidateId ?? this.#idFactory('candidate');
        await this.#upsertAsset(client, {
          id: outcome.candidate.assetId,
          kind: 'generated',
          uri: outcome.candidate.uri,
          metadata: outcome.candidate.metadata ?? {},
          createdAt: now,
        });
        await client.query(
          `INSERT INTO generation_outputs
            (id, generation_id, asset_id, verification_json, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            candidateId,
            generationId,
            outcome.candidate.assetId,
            outcome.candidate.verification ?? {},
            now,
          ],
        );
      }

      return this.#requireGeneration(client, generationId);
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
        `UPDATE generations
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

  async getAsset(assetId) {
    return this.#requireAsset(this.#pool, assetId);
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
      `SELECT id FROM generations
       WHERE project_id = $1
       ORDER BY created_at, id`,
      [projectId],
    );
    return Promise.all(
      result.rows.map(({ id }) => this.#requireGeneration(this.#pool, id)),
    );
  }

  async listGenerationsByTurn({ projectId, turnId }) {
    await this.#requireProject(this.#pool, projectId);
    const generations = await this.#pool.query(
      `SELECT * FROM generations
       WHERE project_id = $1 AND turn_id = $2
       ORDER BY created_at, id`,
      [projectId, turnId],
    );
    if (generations.rowCount === 0) return [];
    const candidates = await this.#pool.query(
      `WITH turn_generations AS (
         SELECT id
         FROM generations
         WHERE project_id = $1 AND turn_id = $2
       )
       SELECT output.*
       FROM generation_outputs AS output
       JOIN turn_generations ON turn_generations.id = output.generation_id
       ORDER BY output.generation_id, output.created_at, output.id`,
      [projectId, turnId],
    );
    const candidatesByGeneration = new Map();
    for (const row of candidates.rows) {
      const candidateRows = candidatesByGeneration.get(row.generation_id) ?? [];
      candidateRows.push(row);
      candidatesByGeneration.set(row.generation_id, candidateRows);
    }
    return generations.rows.map((row) => mapGeneration(
      row,
      candidatesByGeneration.get(row.id) ?? [],
    ));
  }

  async #upsertAsset(
    client,
    { id, kind, uri = null, metadata = {}, createdAt },
  ) {
    await client.query(
      `INSERT INTO assets (id, kind, uri, metadata_json, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         uri = EXCLUDED.uri,
         metadata_json = EXCLUDED.metadata_json`,
      [id, kind, uri, metadata, createdAt],
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

  async #requireGeneration(database, generationId) {
    const result = await database.query(
      'SELECT * FROM generations WHERE id = $1',
      [generationId],
    );
    if (result.rowCount === 0) throw new GenerationNotFoundError(generationId);
    const candidates = await database.query(
      `SELECT * FROM generation_outputs
       WHERE generation_id = $1
       ORDER BY created_at, id`,
      [generationId],
    );
    return mapGeneration(result.rows[0], candidates.rows);
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

  async #requireAsset(database, assetId) {
    const result = await database.query(
      'SELECT * FROM assets WHERE id = $1',
      [assetId],
    );
    if (result.rowCount === 0) throw new AssetNotFoundError(assetId);
    return mapAsset(result.rows[0]);
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
    runningTurnId: row.running_turn_id,
    ownerId: row.owner_id,
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

function mapAsset(row) {
  return {
    id: row.id,
    kind: row.kind,
    uri: row.uri,
    metadata: row.metadata_json,
  };
}

function mapGeneration(row, candidateRows) {
  return {
    id: row.id,
    projectId: row.project_id,
    turnId: row.turn_id,
    inputRevisionId: row.input_revision_id,
    inputAssetId: row.input_asset_id,
    patch: row.patch_json,
    proposedState: row.proposed_state_json,
    status: row.status,
    candidates: candidateRows.map(mapCandidate),
    selectedCandidateId: row.selected_candidate_id,
    selectedRevisionId: row.selected_revision_id,
    error: row.last_error_json,
    renderPrompt: row.metadata_json?.renderPrompt ?? null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
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
