import type { Pool } from "pg";

import { resolveAssetStorageKey } from "../infrastructure/storage/asset-storage.js";

const TURN_QUERY = `
  SELECT id, project_id, user_message, status, outcome_json, error_json,
         created_at, updated_at
  FROM agent_turns
  WHERE id = $1 AND project_id = $2
`;

function toIso(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : value == null ? null : String(value);
}

function turnNotFound(projectId: string, turnId: string) {
  return Object.assign(new Error(`Turn not found in project ${projectId}: ${turnId}`), { code: "TURN_NOT_FOUND" });
}

export function createTurnViews({ pool, repository, assetStorage, signedUrlTtlSeconds }: {
  pool: Pool;
  repository: any;
  assetStorage: any;
  signedUrlTtlSeconds: number;
}) {
  if (!pool) throw new TypeError("createTurnViews requires pool");
  if (!repository) throw new TypeError("createTurnViews requires repository");
  if (!assetStorage) throw new TypeError("createTurnViews requires assetStorage");
  if (!Number.isInteger(signedUrlTtlSeconds) || signedUrlTtlSeconds <= 0) {
    throw new TypeError("createTurnViews requires a positive signedUrlTtlSeconds");
  }

  async function buildCandidate(candidate: any) {
    const view = { id: candidate.id, assetId: candidate.assetId, url: null as string | null, contentType: null as string | null };
    try {
      const asset = await repository.getAsset(candidate.assetId);
      const key = resolveAssetStorageKey(asset.uri, assetStorage.bucket);
      view.url = await assetStorage.getSignedUrl(key, { expiresInSeconds: signedUrlTtlSeconds });
      view.contentType = asset.metadata?.contentType ?? null;
      return view;
    } catch (error: any) {
      if (error?.code !== "ASSET_NOT_FOUND") throw error;
      return { ...view, urlError: error?.message ?? String(error) };
    }
  }

  async function loadTurnDetail({ projectId, turnId }: { projectId: string; turnId: string }) {
    const result = await pool.query(TURN_QUERY, [turnId, projectId]);
    const row = result.rows[0];
    if (!row) throw turnNotFound(projectId, turnId);

    const generations = await repository.listGenerationsByTurn({ projectId, turnId });
    return {
      turnId: row.id,
      projectId: row.project_id,
      status: row.status,
      userMessage: row.user_message,
      error: row.error_json ?? null,
      outcome: row.outcome_json ?? null,
      generations: await Promise.all(generations.map(async (generation: any) => ({
        generationId: generation.id,
        status: generation.status,
        patch: generation.patch,
        renderPrompt: generation.renderPrompt,
        selectedCandidateId: generation.selectedCandidateId,
        selectedRevisionId: generation.selectedRevisionId,
        ...(generation.candidates?.length ? { candidate: await buildCandidate(generation.candidates[0]) } : {}),
      }))),
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  async function fingerprint({ projectId, turnId }: { projectId: string; turnId: string }) {
    const result = await pool.query(
      `SELECT t.updated_at AS turn_updated_at,
              COUNT(g.id)::text AS generation_count,
              COUNT(g.selected_candidate_id)::text AS selected_count,
              MAX(g.updated_at)::text AS generations_updated_at
       FROM agent_turns t
       LEFT JOIN generations g ON g.turn_id = t.id
       WHERE t.id = $1 AND t.project_id = $2
       GROUP BY t.updated_at`,
      [turnId, projectId],
    );
    const row = result.rows[0];
    return row ? JSON.stringify([row.turn_updated_at, row.generations_updated_at, row.generation_count, row.selected_count]) : null;
  }

  async function turnChangedSince({ projectId, turnId, lastFingerprint }: { projectId: string; turnId: string; lastFingerprint?: string | null }) {
    const next = await fingerprint({ projectId, turnId });
    if (next === null) throw turnNotFound(projectId, turnId);
    return { changed: next !== lastFingerprint, fingerprint: next };
  }

  async function assertTurnExists({ projectId, turnId }: { projectId: string; turnId: string }) {
    const result = await pool.query("SELECT 1 FROM agent_turns WHERE id = $1 AND project_id = $2", [turnId, projectId]);
    if (result.rows.length === 0) throw turnNotFound(projectId, turnId);
    return true;
  }

  return { loadTurnDetail, turnChangedSince, assertTurnExists };
}
