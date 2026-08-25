import { randomUUID } from "node:crypto";

import { SELECTABLE_GENERATION_STATUSES } from "./generation-lifecycle.js";
import { applyPhotoStatePatch, type StatePatch } from "./photo-state.js";
import type {
  Asset,
  AssetDescriptor,
  Candidate,
  CreateProjectInput,
  Generation,
  GenerationOutcome,
  PhotoProjectRepository,
  Project,
  RecordAssetInput,
  RecordGenerationInput,
  Revision,
  SelectCandidateInput,
} from "./photo-project.js";

import {
  AssetNotFoundError,
  CandidateSelectionError,
  DomainError,
  GenerationNotFoundError,
  InvalidGenerationRequestError,
  ProjectNotFoundError,
  RevisionConflictError,
  RevisionNotFoundError,
} from "./errors.js";

export {
  AssetNotFoundError,
  CandidateSelectionError,
  DomainError,
  GenerationNotFoundError,
  InvalidGenerationRequestError,
  ProjectNotFoundError,
  RevisionConflictError,
  RevisionNotFoundError,
  TurnNotFoundError,
} from "./errors.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

interface StoredAsset {
  id: string;
  kind: string;
  uri: string | null;
  metadata: Record<string, unknown>;
}

/**
 * PhotoProjectRepository 的内存实现，作为单元测试的替身；
 * 生产实现是 PostgresPhotoProjectRepository，两者共享 photo-project.ts 里的端口契约。
 */
export class InMemoryPhotoProjectService implements PhotoProjectRepository {
  readonly #projects = new Map<string, Project>();
  readonly #revisions = new Map<string, Revision>();
  readonly #generations = new Map<string, Generation>();
  readonly #assets = new Map<string, StoredAsset>();
  readonly #idFactory: (prefix: string) => string;
  readonly #now: () => string;

  constructor({
    idFactory = (prefix: string) => `${prefix}_${randomUUID()}`,
    now = () => new Date().toISOString(),
  } = {}) {
    this.#idFactory = idFactory;
    this.#now = now;
  }

  async createProject({ projectId, name, initialState, anchorAsset = null, ownerId }: CreateProjectInput): Promise<Project> {
    const id = projectId ?? this.#idFactory("project");
    if (this.#projects.has(id)) {
      throw new DomainError(`Project already exists: ${id}`, "PROJECT_EXISTS");
    }

    const createdAt = this.#now();
    const validatedInitialState = applyPhotoStatePatch(initialState, { modify: [], preserve: [] });
    const revision: Revision = {
      id: this.#idFactory("revision"),
      projectId: id,
      parentRevisionId: null,
      state: validatedInitialState,
      anchorAssetId: anchorAsset?.assetId ?? null,
      sourceGenerationId: null,
      createdAt,
    };
    const project: Project = {
      id,
      name,
      activeRevisionId: revision.id,
      runningTurnId: null,
      ownerId,
      createdAt,
      updatedAt: createdAt,
    };

    if (anchorAsset) this.#rememberAsset(anchorAsset, "source");
    this.#projects.set(id, project);
    this.#revisions.set(revision.id, revision);
    return clone(project);
  }

  async recordGeneration({ projectId, turnId, baseRevisionId, inputAssetId, patch, renderPrompt = null, outcome }: RecordGenerationInput): Promise<Generation> {
    if (typeof turnId !== "string" || turnId.trim() === "") {
      throw new InvalidGenerationRequestError("Generation requires a non-empty turn id");
    }
    const completed = outcome?.kind === "completed";
    const failed = outcome?.kind === "failed";
    if (!completed && !failed) {
      throw new InvalidGenerationRequestError("Generation outcome must be completed or failed");
    }

    const project = this.#requireProject(projectId);
    const baseRevision = this.#requireRevision(baseRevisionId);
    if (baseRevision.projectId !== projectId) {
      throw new RevisionConflictError({ projectId, expectedRevisionId: baseRevisionId, actualRevisionId: null });
    }
    if (project.activeRevisionId !== baseRevisionId) {
      throw new RevisionConflictError({ projectId, expectedRevisionId: baseRevisionId, actualRevisionId: project.activeRevisionId });
    }

    const proposedState = applyPhotoStatePatch(baseRevision.state, patch as unknown as StatePatch);
    const completedCandidate: Candidate | null = completed && outcome.candidate
      ? {
          id: outcome.candidate.candidateId ?? this.#idFactory("candidate"),
          assetId: outcome.candidate.assetId,
          verification: {},
          createdAt: this.#now(),
        }
      : null;
    if (completedCandidate) {
      this.#rememberAsset({
        assetId: completedCandidate.assetId,
        uri: outcome.candidate?.uri,
        metadata: outcome.candidate?.metadata,
      }, "generated");
    }

    const createdAt = this.#now();
    const generation: Generation = {
      id: this.#idFactory("generation"),
      projectId,
      turnId,
      inputRevisionId: baseRevisionId,
      inputAssetId,
      patch: structuredClone(patch),
      proposedState,
      status: completed ? "completed" : "failed",
      candidates: completedCandidate ? [completedCandidate] : [],
      error: failed ? structuredClone(outcome.error!) : null,
      selectedCandidateId: null,
      selectedRevisionId: null,
      renderPrompt,
      createdAt,
      updatedAt: createdAt,
    };

    this.#generations.set(generation.id, generation);
    return clone(generation);
  }

  async selectCandidate({ projectId, generationId, candidateId }: SelectCandidateInput): Promise<Revision> {
    const project = this.#requireProject(projectId);
    const generation = this.#requireGeneration(generationId);
    this.#assertGenerationBelongsToProject(generation, projectId);

    if (generation.selectedCandidateId) {
      return this.#handleRepeatedSelection(generation, candidateId);
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

    const candidate = generation.candidates.find(({ id }) => id === candidateId);
    if (!candidate) {
      throw new CandidateSelectionError(
        `Candidate ${candidateId} does not belong to generation ${generationId}`,
      );
    }

    const revision: Revision = {
      id: this.#idFactory("revision"),
      projectId,
      parentRevisionId: generation.inputRevisionId,
      state: structuredClone(generation.proposedState),
      anchorAssetId: candidate.assetId,
      sourceGenerationId: generationId,
      createdAt: this.#now(),
    };

    this.#revisions.set(revision.id, revision);
    generation.selectedCandidateId = candidateId;
    generation.selectedRevisionId = revision.id;
    generation.updatedAt = this.#now();
    project.activeRevisionId = this.#revisions.get(revision.id)!.id;
    project.updatedAt = this.#now();
    return clone(revision);
  }

  async recordAsset({ assetId, kind = "source", uri, metadata = {} }: RecordAssetInput): Promise<Asset> {
    this.#rememberAsset({ assetId, uri: uri ?? undefined, metadata }, kind);
    return this.getAsset(assetId);
  }

  async getProject(projectId: string): Promise<Project> {
    return clone(this.#requireProject(projectId));
  }

  async getGeneration(generationId: string): Promise<Generation> {
    return clone(this.#requireGeneration(generationId));
  }

  async getRevision(revisionId: string): Promise<Revision> {
    return clone(this.#requireRevision(revisionId));
  }

  async getAsset(assetId: string): Promise<Asset> {
    const asset = this.#assets.get(assetId);
    if (!asset) throw new AssetNotFoundError(assetId);
    return clone(asset);
  }

  async listRevisions(projectId: string): Promise<Revision[]> {
    this.#requireProject(projectId);
    return [...this.#revisions.values()].filter((r) => r.projectId === projectId).map(clone);
  }

  async listGenerations(projectId: string): Promise<Generation[]> {
    this.#requireProject(projectId);
    return [...this.#generations.values()].filter((g) => g.projectId === projectId).map(clone);
  }

  async listGenerationsByTurn({ projectId, turnId }: { projectId: string; turnId: string }): Promise<Generation[]> {
    this.#requireProject(projectId);
    return [...this.#generations.values()]
      .filter((g) => g.projectId === projectId && g.turnId === turnId)
      .map(clone);
  }

  #rememberAsset(descriptor: AssetDescriptor, kind: string): void {
    this.#assets.set(descriptor.assetId, {
      id: descriptor.assetId,
      kind,
      uri: descriptor.uri ?? null,
      metadata: descriptor.metadata ?? {},
    });
  }

  #requireProject(projectId: string): Project {
    const project = this.#projects.get(projectId);
    if (!project) throw new ProjectNotFoundError(projectId);
    return project;
  }

  #requireGeneration(generationId: string): Generation {
    const generation = this.#generations.get(generationId);
    if (!generation) throw new GenerationNotFoundError(generationId);
    return generation;
  }

  #requireRevision(revisionId: string): Revision {
    const revision = this.#revisions.get(revisionId);
    if (!revision) throw new RevisionNotFoundError(revisionId);
    return revision;
  }

  #assertGenerationBelongsToProject(generation: Generation, projectId: string): void {
    if (generation.projectId !== projectId) {
      throw new CandidateSelectionError(
        `Generation ${generation.id} does not belong to project ${projectId}`,
      );
    }
  }

  #handleRepeatedSelection(generation: Generation, candidateId: string): Revision {
    if (generation.selectedCandidateId !== candidateId) {
      throw new CandidateSelectionError(
        `Generation ${generation.id} already selected candidate ${generation.selectedCandidateId}`,
      );
    }
    return clone(this.#requireRevision(generation.selectedRevisionId!));
  }
}
