import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { and, asc, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";

import {
  AssetNotFoundError,
  CandidateSelectionError,
  GenerationNotFoundError,
  InvalidGenerationRequestError,
  ProjectNotFoundError,
  RevisionConflictError,
  TurnNotFoundError,
} from "../../domain/photo-project-service.js";
import { SELECTABLE_GENERATION_STATUSES } from "../../domain/generation-lifecycle.js";
import { applyPhotoStatePatch } from "../../domain/photo-state.js";
import * as schema from "../../db/schema.js";
import {
  agentTurns,
  assets,
  generationOutputs,
  generations,
  photoRevisions,
  projects,
} from "../../db/schema.js";

type Database = NodePgDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Queryable = Database | Transaction;

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function notFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error &&
    (error as { code?: string }).code === "REVISION_NOT_FOUND");
}

function mapProject(row: typeof projects.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    activeRevisionId: row.activeRevisionId,
    runningTurnId: row.runningTurnId,
    ownerId: row.ownerId,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

function mapRevision(row: typeof photoRevisions.$inferSelect) {
  return {
    id: row.id,
    projectId: row.projectId,
    parentRevisionId: row.parentRevisionId,
    state: row.stateJson,
    anchorAssetId: row.anchorAssetId,
    sourceGenerationId: row.sourceGenerationId,
    createdAt: toIso(row.createdAt),
  };
}

function mapAsset(row: typeof assets.$inferSelect) {
  return {
    id: row.id,
    kind: row.kind,
    uri: row.uri,
    metadata: row.metadataJson,
  };
}

function mapCandidate(row: typeof generationOutputs.$inferSelect) {
  return {
    id: row.id,
    assetId: row.assetId,
    verification: row.verificationJson,
    createdAt: toIso(row.createdAt),
  };
}

function mapGeneration(
  row: typeof generations.$inferSelect,
  candidateRows: Array<typeof generationOutputs.$inferSelect> = [],
) {
  return {
    id: row.id,
    projectId: row.projectId,
    turnId: row.turnId,
    inputRevisionId: row.inputRevisionId,
    inputAssetId: row.inputAssetId,
    patch: row.patchJson,
    proposedState: row.proposedStateJson,
    status: row.status,
    candidates: candidateRows.map(mapCandidate),
    selectedCandidateId: row.selectedCandidateId,
    selectedRevisionId: row.selectedRevisionId,
    error: row.lastErrorJson,
    renderPrompt: (row.metadataJson as { renderPrompt?: string | null }).renderPrompt ?? null,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

export class PostgresPhotoProjectRepository {
  readonly #pool: Pool;
  readonly #db: Database;
  readonly #idFactory: (prefix: string) => string;
  readonly #now: () => Date;

  constructor({
    pool,
    idFactory = (prefix: string) => `${prefix}_${randomUUID()}`,
    now = () => new Date(),
  }: {
    pool: Pool;
    idFactory?: (prefix: string) => string;
    now?: () => Date;
  }) {
    this.#pool = pool;
    this.#db = drizzle(pool, { schema });
    this.#idFactory = idFactory;
    this.#now = now;
  }

  async createProject({
    projectId,
    name,
    initialState,
    anchorAsset = null,
    ownerId = "dev",
  }: {
    projectId?: string;
    name: string;
    initialState: Record<string, unknown>;
    anchorAsset?: { assetId: string; uri?: string; metadata?: Record<string, unknown> } | null;
    ownerId?: string;
  }) {
    const id = projectId ?? this.#idFactory("project");
    const revisionId = this.#idFactory("revision");
    const now = this.#now();
    const state = applyPhotoStatePatch(initialState as any, { modify: [], preserve: [] });

    return this.#transaction(async (db) => {
      if (anchorAsset) {
        await db.insert(assets).values({
          id: anchorAsset.assetId,
          kind: "source",
          uri: anchorAsset.uri ?? null,
          metadataJson: anchorAsset.metadata ?? {},
          createdAt: now,
        }).onConflictDoUpdate({
          target: assets.id,
          set: { uri: anchorAsset.uri ?? null, metadataJson: anchorAsset.metadata ?? {} },
        });
      }

      await db.insert(projects).values({
        id,
        name,
        activeRevisionId: null,
        ownerId,
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(photoRevisions).values({
        id: revisionId,
        projectId: id,
        parentRevisionId: null,
        stateJson: state,
        anchorAssetId: anchorAsset?.assetId ?? null,
        sourceGenerationId: null,
        createdAt: now,
      });
      const [row] = await db.update(projects)
        .set({ activeRevisionId: revisionId, updatedAt: now })
        .where(eq(projects.id, id))
        .returning();
      return mapProject(row);
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
  }: {
    projectId: string;
    turnId: string;
    baseRevisionId: string;
    inputAssetId: string | null;
    patch: Record<string, unknown>;
    renderPrompt?: string | null;
    outcome?: Record<string, any>;
  }) {
    if (typeof turnId !== "string" || turnId.trim() === "") {
      throw new InvalidGenerationRequestError("Generation requires a non-empty turn id");
    }
    const completed = outcome?.kind === "completed";
    const failed = outcome?.kind === "failed";
    if (!completed && !failed) {
      throw new InvalidGenerationRequestError("Generation outcome must be completed or failed");
    }

    return this.#transaction(async (db) => {
      const projectRows = await db.select().from(projects)
        .where(eq(projects.id, projectId)).for("update");
      const projectRow = projectRows[0];
      if (!projectRow) throw new ProjectNotFoundError(projectId);

      if (projectRow.activeRevisionId !== baseRevisionId) {
        throw new RevisionConflictError({
          projectId,
          expectedRevisionId: baseRevisionId,
          actualRevisionId: projectRow.activeRevisionId,
        });
      }

      const turnRows = await db.select({ id: agentTurns.id }).from(agentTurns)
        .where(and(eq(agentTurns.id, turnId), eq(agentTurns.projectId, projectId)));
      if (!turnRows[0]) throw new TurnNotFoundError(projectId, turnId);

      if (inputAssetId != null) {
        const assetRows = await db.select({ id: assets.id }).from(assets)
          .where(eq(assets.id, inputAssetId));
        if (!assetRows[0]) throw new AssetNotFoundError(inputAssetId);
      }

      const revisionRows = await db.select().from(photoRevisions)
        .where(eq(photoRevisions.id, baseRevisionId));
      const revisionRow = revisionRows[0];
      if (!revisionRow) {
        const error: Error & { code?: string } = new Error(`Revision not found: ${baseRevisionId}`);
        error.code = "REVISION_NOT_FOUND";
        throw error;
      }

      const proposedState = applyPhotoStatePatch(revisionRow.stateJson as any, patch as any);
      const generationId = this.#idFactory("generation");
      const now = this.#now();

      await db.insert(generations).values({
        id: generationId,
        projectId,
        inputRevisionId: baseRevisionId,
        patchJson: patch,
        proposedStateJson: proposedState,
        status: completed ? "completed" : "failed",
        inputAssetId: inputAssetId ?? null,
        turnId,
        metadataJson: { renderPrompt },
        lastErrorJson: failed ? outcome.error ?? null : null,
        createdAt: now,
        updatedAt: now,
      });

      let candidateId: string | null = null;
      if (completed && outcome.candidate) {
        candidateId = outcome.candidate.candidateId ?? this.#idFactory("candidate");
        await db.insert(assets).values({
          id: outcome.candidate.assetId,
          kind: "generated",
          uri: outcome.candidate.uri ?? null,
          metadataJson: outcome.candidate.metadata ?? {},
          createdAt: now,
        }).onConflictDoUpdate({
          target: assets.id,
          set: {
            uri: outcome.candidate.uri ?? null,
            metadataJson: outcome.candidate.metadata ?? {},
          },
        });
        await db.insert(generationOutputs).values([{
          id: candidateId!,
          generationId,
          assetId: outcome.candidate.assetId,
          verificationJson: outcome.candidate.verification ?? {},
          createdAt: now,
        }]);
      }

      const [row] = await db.select().from(generations).where(eq(generations.id, generationId));
      const candidateRows = await db.select().from(generationOutputs)
        .where(eq(generationOutputs.generationId, generationId))
        .orderBy(asc(generationOutputs.createdAt), asc(generationOutputs.id));
      return mapGeneration(row, candidateRows);
    });
  }

  async selectCandidate({
    projectId,
    generationId,
    candidateId,
  }: {
    projectId: string;
    generationId: string;
    candidateId: string;
  }) {
    return this.#transaction(async (db) => {
      const generationRows = await db.select().from(generations)
        .where(eq(generations.id, generationId)).for("update");
      const generation = generationRows[0];
      if (!generation) throw new GenerationNotFoundError(generationId);

      const projectRows = await db.select().from(projects)
        .where(eq(projects.id, projectId)).for("update");
      const project = projectRows[0];
      if (!project) throw new ProjectNotFoundError(projectId);

      if (generation.projectId !== projectId) {
        throw new CandidateSelectionError(`Generation ${generationId} does not belong to project ${projectId}`);
      }
      if (generation.selectedCandidateId) {
        if (generation.selectedCandidateId !== candidateId) {
          throw new CandidateSelectionError(`Generation ${generationId} already selected candidate ${generation.selectedCandidateId}`);
        }
        return this.#requireRevision(db, generation.selectedRevisionId!);
      }
      if (!SELECTABLE_GENERATION_STATUSES.has(generation.status)) {
        throw new CandidateSelectionError(`Generation ${generationId} is not selectable in status ${generation.status}`);
      }
      if (project.activeRevisionId !== generation.inputRevisionId) {
        throw new RevisionConflictError({
          projectId,
          expectedRevisionId: generation.inputRevisionId,
          actualRevisionId: project.activeRevisionId,
        });
      }

      const candidateRows = await db.select().from(generationOutputs)
        .where(and(
          eq(generationOutputs.id, candidateId),
          eq(generationOutputs.generationId, generationId),
        ));
      const candidate = candidateRows[0];
      if (!candidate) {
        throw new CandidateSelectionError(`Candidate ${candidateId} does not belong to generation ${generationId}`);
      }

      const revisionId = this.#idFactory("revision");
      const now = this.#now();
      const [revision] = await db.insert(photoRevisions).values({
        id: revisionId,
        projectId,
        parentRevisionId: generation.inputRevisionId,
        stateJson: generation.proposedStateJson,
        anchorAssetId: candidate.assetId,
        sourceGenerationId: generationId,
        createdAt: now,
      }).returning();
      await db.update(generations).set({
        selectedCandidateId: candidateId,
        selectedRevisionId: revisionId,
        updatedAt: now,
      }).where(eq(generations.id, generationId));
      await db.update(projects).set({
        activeRevisionId: revisionId,
        updatedAt: now,
      }).where(eq(projects.id, projectId));
      return mapRevision(revision);
    });
  }

  getProject(projectId: string) {
    return this.#requireProject(this.#db, projectId);
  }

  getGeneration(generationId: string) {
    return this.#requireGeneration(this.#db, generationId);
  }

  getRevision(revisionId: string) {
    return this.#requireRevision(this.#db, revisionId);
  }

  getAsset(assetId: string) {
    return this.#requireAsset(this.#db, assetId);
  }

  async recordAsset({
    assetId,
    kind = "source",
    uri = null,
    metadata = {},
  }: {
    assetId: string;
    kind?: string;
    uri?: string | null;
    metadata?: Record<string, unknown>;
  }) {
    return this.#transaction(async (db) => {
      await db.insert(assets).values({
        id: assetId,
        kind,
        uri,
        metadataJson: metadata,
        createdAt: this.#now(),
      }).onConflictDoUpdate({
        target: assets.id,
        set: { uri, metadataJson: metadata },
      });
      return this.#requireAsset(db, assetId);
    });
  }

  async listRevisions(projectId: string) {
    await this.#requireProject(this.#db, projectId);
    const rows = await this.#db.select().from(photoRevisions)
      .where(eq(photoRevisions.projectId, projectId))
      .orderBy(asc(photoRevisions.createdAt), asc(photoRevisions.id));
    return rows.map(mapRevision);
  }

  async listGenerations(projectId: string) {
    await this.#requireProject(this.#db, projectId);
    const rows = await this.#db.select({ id: generations.id }).from(generations)
      .where(eq(generations.projectId, projectId))
      .orderBy(asc(generations.createdAt), asc(generations.id));
    return Promise.all(rows.map(({ id }) => this.getGeneration(id)));
  }

  async listGenerationsByTurn({ projectId, turnId }: { projectId: string; turnId: string }) {
    await this.#requireProject(this.#db, projectId);
    const rows = await this.#db.select().from(generations)
      .where(and(eq(generations.projectId, projectId), eq(generations.turnId, turnId)))
      .orderBy(asc(generations.createdAt), asc(generations.id));
    if (rows.length === 0) return [];

    const candidateRows = await this.#db.select({
      output: generationOutputs,
    }).from(generationOutputs)
      .innerJoin(generations, eq(generations.id, generationOutputs.generationId))
      .where(and(eq(generations.projectId, projectId), eq(generations.turnId, turnId)))
      .orderBy(asc(generationOutputs.generationId), asc(generationOutputs.createdAt), asc(generationOutputs.id));

    const byGeneration = new Map<string, Array<typeof generationOutputs.$inferSelect>>();
    for (const { output } of candidateRows) {
      const values = byGeneration.get(output.generationId) ?? [];
      values.push(output);
      byGeneration.set(output.generationId, values);
    }
    return rows.map((row) => mapGeneration(row, byGeneration.get(row.id) ?? []));
  }

  async #requireProject(database: Queryable, projectId: string) {
    const rows = await database.select().from(projects).where(eq(projects.id, projectId));
    if (!rows[0]) throw new ProjectNotFoundError(projectId);
    return mapProject(rows[0]);
  }

  async #requireGeneration(database: Queryable, generationId: string) {
    const rows = await database.select().from(generations).where(eq(generations.id, generationId));
    if (!rows[0]) throw new GenerationNotFoundError(generationId);
    const candidateRows = await database.select().from(generationOutputs)
      .where(eq(generationOutputs.generationId, generationId))
      .orderBy(asc(generationOutputs.createdAt), asc(generationOutputs.id));
    return mapGeneration(rows[0], candidateRows);
  }

  async #requireRevision(database: Queryable, revisionId: string) {
    const rows = await database.select().from(photoRevisions).where(eq(photoRevisions.id, revisionId));
    if (!rows[0]) {
      const error: Error & { code?: string } = new Error(`Revision not found: ${revisionId}`);
      error.code = "REVISION_NOT_FOUND";
      throw error;
    }
    return mapRevision(rows[0]);
  }

  async #requireAsset(database: Queryable, assetId: string) {
    const rows = await database.select().from(assets).where(eq(assets.id, assetId));
    if (!rows[0]) throw new AssetNotFoundError(assetId);
    return mapAsset(rows[0]);
  }

  async #transaction<T>(callback: (database: Transaction) => Promise<T>): Promise<T> {
    return this.#db.transaction(async (database) => callback(database));
  }
}
