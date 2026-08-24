import { randomUUID } from "node:crypto";

import {
  SELECTABLE_GENERATION_STATUSES,
} from "./generation-lifecycle.js";
import { applyPhotoStatePatch } from "./photo-state.js";

type PhotoState = Record<string, unknown> & { constraints?: unknown[] };

interface Candidate {
  id: string;
  assetId: string;
  verification: Record<string, unknown>;
  createdAt: string;
}

interface GenerationOutcome {
  kind: "completed" | "failed";
  candidate?: { candidateId?: string; assetId: string; verification?: Record<string, unknown>; uri?: string; metadata?: Record<string, unknown> };
  error?: Record<string, unknown>;
}

interface Revision {
  id: string;
  projectId: string;
  parentRevisionId: string | null;
  state: PhotoState;
  anchorAssetId: string | null;
  sourceGenerationId: string | null;
  createdAt: string;
}

interface Project {
  id: string;
  name: string;
  activeRevisionId: string;
  runningTurnId: string | null;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

interface Generation {
  id: string;
  projectId: string;
  turnId: string;
  inputRevisionId: string;
  inputAssetId: string | null;
  patch: Record<string, unknown>;
  proposedState: PhotoState;
  status: "completed" | "failed";
  candidates: Candidate[];
  error: Record<string, unknown> | null;
  selectedCandidateId: string | null;
  selectedRevisionId: string | null;
  renderPrompt: string | null;
  createdAt: string;
  updatedAt: string;
}

export class DomainError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class ProjectNotFoundError extends DomainError {
  projectId: string;
  constructor(projectId: string) {
    super(`Project not found: ${projectId}`, "PROJECT_NOT_FOUND");
    this.projectId = projectId;
  }
}

export class GenerationNotFoundError extends DomainError {
  generationId: string;
  constructor(generationId: string) {
    super(`Generation not found: ${generationId}`, "GENERATION_NOT_FOUND");
    this.generationId = generationId;
  }
}

export class RevisionConflictError extends DomainError {
  projectId: string;
  expectedRevisionId: string;
  actualRevisionId: string | null;
  constructor({ projectId, expectedRevisionId, actualRevisionId }: { projectId: string; expectedRevisionId: string; actualRevisionId: string | null }) {
    super(
      `Revision conflict for project ${projectId}: expected ${expectedRevisionId}, active ${actualRevisionId}`,
      "REVISION_CONFLICT",
    );
    this.projectId = projectId;
    this.expectedRevisionId = expectedRevisionId;
    this.actualRevisionId = actualRevisionId;
  }
}

export class RevisionNotFoundError extends DomainError {
  revisionId: string;
  constructor(revisionId: string) {
    super(`Revision not found: ${revisionId}`, "REVISION_NOT_FOUND");
    this.revisionId = revisionId;
  }
}

export class InvalidGenerationRequestError extends DomainError {
  constructor(message: string) {
    super(message, "INVALID_GENERATION_REQUEST");
  }
}

export class CandidateSelectionError extends DomainError {
  constructor(message: string) {
    super(message, "CANDIDATE_SELECTION_ERROR");
  }
}

export class TurnNotFoundError extends DomainError {
  projectId: string;
  turnId: string;
  constructor(projectId: string, turnId: string) {
    super(`Turn not found for project ${projectId}: ${turnId}`, "TURN_NOT_FOUND");
    this.projectId = projectId;
    this.turnId = turnId;
  }
}

export class AssetNotFoundError extends DomainError {
  assetId: string;
  constructor(assetId: string) {
    super(`Asset not found: ${assetId}`, "ASSET_NOT_FOUND");
    this.assetId = assetId;
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class PhotoProjectService {
  readonly #projects = new Map<string, Project>();
  readonly #revisions = new Map<string, Revision>();
  readonly #generations = new Map<string, Generation>();
  readonly #idFactory: (prefix: string) => string;
  readonly #now: () => string;

  constructor({
    idFactory = (prefix: string) => `${prefix}_${randomUUID()}`,
    now = () => new Date().toISOString(),
  } = {}) {
    this.#idFactory = idFactory;
    this.#now = now;
  }

  createProject({ projectId, name, initialState, anchorAsset = null }: {
    projectId?: string;
    name: string;
    initialState: PhotoState;
    anchorAsset?: { assetId: string; uri?: string; metadata?: Record<string, unknown> } | null;
  }): Project {
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
      ownerId: "dev",
      createdAt,
      updatedAt: createdAt,
    };

    this.#projects.set(id, project);
    this.#revisions.set(revision.id, revision);
    return clone(project);
  }

  recordGeneration({ projectId, turnId, baseRevisionId, inputAssetId, patch, renderPrompt = null, outcome }: {
    projectId: string;
    turnId: string;
    baseRevisionId: string;
    inputAssetId: string | null;
    patch: Record<string, unknown>;
    renderPrompt?: string | null;
    outcome?: GenerationOutcome;
  }): Generation {
    if (typeof turnId !== "string" || turnId.trim() === "") {
      throw new InvalidGenerationRequestError("Generation requires a non-empty turn id");
    }

    const project = this["#requireProject"](projectId);
    const baseRevision = this["#requireRevision"](baseRevisionId);
    if (baseRevision.projectId !== projectId) {
      throw new RevisionConflictError({ projectId, expectedRevisionId: baseRevisionId, actualRevisionId: null });
    }
    if (project.activeRevisionId !== baseRevisionId) {
      throw new RevisionConflictError({ projectId, expectedRevisionId: baseRevisionId, actualRevisionId: project.activeRevisionId });
    }

    const proposedState = applyPhotoStatePatch(baseRevision.state as PhotoState, patch as any);
    const completedCandidate: Candidate | null = outcome?.kind === "completed"
      ? {
          id: outcome.candidate!.candidateId ?? this.#idFactory("candidate"),
          assetId: outcome.candidate!.assetId,
          verification: {},
          createdAt: this.#now(),
        }
      : null;

    const generation: Generation = {
      id: this.#idFactory("generation"),
      projectId,
      turnId,
      inputRevisionId: baseRevisionId,
      inputAssetId,
      patch: structuredClone(patch),
      proposedState,
      status: completedCandidate ? "completed" : "failed",
      candidates: completedCandidate ? [completedCandidate] : [],
      error: outcome?.kind === "failed" ? structuredClone(outcome.error!) : null,
      selectedCandidateId: null,
      selectedRevisionId: null,
      renderPrompt,
      createdAt: this.#now(),
      updatedAt: this.#now(),
    };
    generation.updatedAt = generation.createdAt;

    this.#generations.set(generation.id, generation);
    return clone(generation);
  }

  selectCandidate({ projectId, generationId, candidateId }: { projectId: string; generationId: string; candidateId: string }): Revision {
    const project = this["#requireProject"](projectId);
    const generation = this["#requireGeneration"](generationId);
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

  getProject(projectId: string): Project { return clone(this["#requireProject"](projectId)); }
  getGeneration(generationId: string): Generation { return clone(this["#requireGeneration"](generationId)); }
  getRevision(revisionId: string): Revision { return clone(this["#requireRevision"](revisionId)); }

  listRevisions(projectId: string): Revision[] {
    this["#requireProject"](projectId);
    return [...this.#revisions.values()].filter((r) => r.projectId === projectId).map(clone);
  }

  listGenerations(projectId: string): Generation[] {
    this["#requireProject"](projectId);
    return [...this.#generations.values()].filter((g) => g.projectId === projectId).map(clone);
  }

  "#requireProject"(projectId: string): Project {
    const project = this.#projects.get(projectId);
    if (!project) throw new ProjectNotFoundError(projectId);
    return project;
  }

  "#requireGeneration"(generationId: string): Generation {
    const generation = this.#generations.get(generationId);
    if (!generation) throw new GenerationNotFoundError(generationId);
    return generation;
  }

  "#requireRevision"(revisionId: string): Revision {
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
    return clone(this["#requireRevision"](generation.selectedRevisionId!));
  }
}
