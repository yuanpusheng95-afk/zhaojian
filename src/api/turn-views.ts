import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

import * as schema from "../db/schema.js";
import { agentTurns, generations } from "../db/schema.js";
import { TurnNotFoundError } from "../domain/photo-project-service.js";
import type { Candidate, PhotoProjectRepository } from "../domain/photo-project.js";
import { resolveAssetStorageKey } from "../infrastructure/storage/asset-storage.js";

type TurnViewsRepository = Pick<PhotoProjectRepository, "listGenerationsByTurn" | "getAsset">;
type TurnViewsAssetStorage = {
  bucket: string;
  getSignedUrl(key: string, options?: { expiresInSeconds?: number }): Promise<string>;
};

function toIso(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : value == null ? null : String(value);
}

export type TurnViews = ReturnType<typeof createTurnViews>;

export function createTurnViews({ pool, repository, assetStorage, signedUrlTtlSeconds }: {
  pool: Pool;
  repository: TurnViewsRepository;
  assetStorage: TurnViewsAssetStorage;
  signedUrlTtlSeconds: number;
}) {
  if (!pool) throw new TypeError("createTurnViews requires pool");
  if (!repository) throw new TypeError("createTurnViews requires repository");
  if (!assetStorage) throw new TypeError("createTurnViews requires assetStorage");
  if (!Number.isInteger(signedUrlTtlSeconds) || signedUrlTtlSeconds <= 0) {
    throw new TypeError("createTurnViews requires a positive signedUrlTtlSeconds");
  }
  const db = drizzle(pool, { schema, casing: "snake_case" });

  async function buildCandidate(candidate: Pick<Candidate, "id" | "assetId">) {
    const view = { id: candidate.id, assetId: candidate.assetId, url: null as string | null, contentType: null as string | null };
    try {
      const asset = await repository.getAsset(candidate.assetId);
      const key = resolveAssetStorageKey(asset.uri as string, assetStorage.bucket);
      view.url = await assetStorage.getSignedUrl(key, { expiresInSeconds: signedUrlTtlSeconds });
      view.contentType = (asset.metadata as Record<string, unknown>)?.contentType as string ?? null;
      return view;
    } catch (error: any) {
      if (error?.code !== "ASSET_NOT_FOUND") throw error;
      return { ...view, urlError: error?.message ?? String(error) };
    }
  }

  async function loadTurnDetail({ projectId, turnId }: { projectId: string; turnId: string }) {
    const rows = await db.select().from(agentTurns)
      .where(and(eq(agentTurns.id, turnId), eq(agentTurns.projectId, projectId)));
    const row = rows[0];
    if (!row) throw new TurnNotFoundError(projectId, turnId);

    const generations = await repository.listGenerationsByTurn({ projectId, turnId });
    return {
      turnId: row.id,
      projectId: row.projectId,
      status: row.status,
      userMessage: row.userMessage,
      error: row.errorJson ?? null,
      outcome: row.outcomeJson ?? null,
      generations: await Promise.all(generations.map(async (generation: any) => ({
        generationId: generation.id,
        status: generation.status,
        patch: generation.patch,
        renderPrompt: generation.renderPrompt,
        selectedCandidateId: generation.selectedCandidateId,
        selectedRevisionId: generation.selectedRevisionId,
        ...(generation.candidates?.length ? { candidate: await buildCandidate(generation.candidates[0]) } : {}),
      }))),
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    };
  }

  async function fingerprint({ projectId, turnId }: { projectId: string; turnId: string }) {
    const rows = await db.select({
      turnUpdatedAt: sql<string>`max(${agentTurns.updatedAt})::text`,
      generationsUpdatedAt: sql<string | null>`max(${generations.updatedAt})::text`,
      generationCount: sql<number>`count(${generations.id})::int`,
      selectedCount: sql<number>`count(${generations.selectedCandidateId})::int`,
    }).from(agentTurns)
      .leftJoin(generations, eq(generations.turnId, agentTurns.id))
      .where(and(eq(agentTurns.id, turnId), eq(agentTurns.projectId, projectId)))
      .groupBy(agentTurns.updatedAt);
    const row = rows[0];
    return row ? JSON.stringify([row.turnUpdatedAt, row.generationsUpdatedAt, row.generationCount, row.selectedCount]) : null;
  }

  async function turnChangedSince({ projectId, turnId, lastFingerprint }: { projectId: string; turnId: string; lastFingerprint?: string | null }) {
    const next = await fingerprint({ projectId, turnId });
    if (next === null) throw new TurnNotFoundError(projectId, turnId);
    return { changed: next !== lastFingerprint, fingerprint: next };
  }

  async function assertTurnExists({ projectId, turnId }: { projectId: string; turnId: string }) {
    const rows = await db.select({ id: agentTurns.id })
      .from(agentTurns)
      .where(and(eq(agentTurns.id, turnId), eq(agentTurns.projectId, projectId)));
    if (rows.length === 0) throw new TurnNotFoundError(projectId, turnId);
    return true;
  }

  return { loadTurnDetail, turnChangedSince, assertTurnExists };
}
