import { randomUUID } from 'node:crypto';

import {
  SELECTABLE_GENERATION_STATUSES,
  TERMINAL_GENERATION_STATUSES,
} from './generation-lifecycle.mjs';
import { applyPhotoStatePatch } from './photo-state.mjs';

class DomainError extends Error {
  constructor(message, code) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class ProjectNotFoundError extends DomainError {
  constructor(projectId) {
    super(`Project not found: ${projectId}`, 'PROJECT_NOT_FOUND');
    this.projectId = projectId;
  }
}

export class GenerationNotFoundError extends DomainError {
  constructor(generationId) {
    super(`Generation not found: ${generationId}`, 'GENERATION_NOT_FOUND');
    this.generationId = generationId;
  }
}

export class RevisionConflictError extends DomainError {
  constructor({ projectId, expectedRevisionId, actualRevisionId }) {
    super(
      `Revision conflict for project ${projectId}: expected ${expectedRevisionId}, active ${actualRevisionId}`,
      'REVISION_CONFLICT',
    );
    this.projectId = projectId;
    this.expectedRevisionId = expectedRevisionId;
    this.actualRevisionId = actualRevisionId;
  }
}

export class RevisionNotFoundError extends DomainError {
  constructor(revisionId) {
    super(`Revision not found: ${revisionId}`, 'REVISION_NOT_FOUND');
    this.revisionId = revisionId;
  }
}

export class InvalidGenerationRequestError extends DomainError {
  constructor(message) {
    super(message, 'INVALID_GENERATION_REQUEST');
  }
}

export class CandidateSelectionError extends DomainError {
  constructor(message) {
    super(message, 'CANDIDATE_SELECTION_ERROR');
  }
}

export class TurnNotFoundError extends DomainError {
  constructor(projectId, turnId) {
    super(`Turn not found for project ${projectId}: ${turnId}`, 'TURN_NOT_FOUND');
    this.projectId = projectId;
    this.turnId = turnId;
  }
}

export class AssetNotFoundError extends DomainError {
  constructor(assetId) {
    super(`Asset not found: ${assetId}`, 'ASSET_NOT_FOUND');
    this.assetId = assetId;
  }
}

export class PhotoProjectService {
  #projects = new Map();
  #revisions = new Map();
  #generations = new Map();
  #idFactory;
  #now;

  constructor({
    idFactory = (prefix) => `${prefix}_${randomUUID()}`,
    now = () => new Date().toISOString(),
  } = {}) {
    this.#idFactory = idFactory;
    this.#now = now;
  }

  createProject({ projectId, name, initialState, anchorAsset = null }) {
    const id = projectId ?? this.#idFactory('project');
    if (this.#projects.has(id)) {
      throw new DomainError(`Project already exists: ${id}`, 'PROJECT_EXISTS');
    }

    const createdAt = this.#now();
    const validatedInitialState = applyPhotoStatePatch(initialState, {
      modify: [],
      preserve: [],
    });
    const revision = {
      id: this.#idFactory('revision'),
      projectId: id,
      parentRevisionId: null,
      state: validatedInitialState,
      anchorAssetId: anchorAsset?.assetId ?? null,
      sourceGenerationId: null,
      createdAt,
    };
    const project = {
      id,
      name,
      activeRevisionId: revision.id,
      runningTurnId: null,
      ownerId: 'dev',
      createdAt,
      updatedAt: createdAt,
    };

    this.#projects.set(id, project);
    this.#revisions.set(revision.id, revision);
    return clone(project);
  }

  recordGeneration({
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

    const project = this.#requireProject(projectId);
    const baseRevision = this.#requireRevision(baseRevisionId);
    if (baseRevision.projectId !== projectId) {
      throw new RevisionConflictError({
        projectId,
        expectedRevisionId: baseRevisionId,
        actualRevisionId: null,
      });
    }
    if (project.activeRevisionId !== baseRevisionId) {
      throw new RevisionConflictError({
        projectId,
        expectedRevisionId: baseRevisionId,
        actualRevisionId: project.activeRevisionId,
      });
    }

    const proposedState = applyPhotoStatePatch(baseRevision.state, patch);
    const completedCandidate = outcome?.kind === 'completed'
      ? {
          id: outcome.candidate.candidateId ?? this.#idFactory('candidate'),
          assetId: outcome.candidate.assetId,
          verification: {},
          createdAt: this.#now(),
        }
      : null;

    const generation = {
      id: this.#idFactory('generation'),
      projectId,
      turnId,
      inputRevisionId: baseRevisionId,
      inputAssetId,
      patch: structuredClone(patch),
      proposedState,
      status: completedCandidate ? 'completed' : 'failed',
      candidates: completedCandidate ? [completedCandidate] : [],
      error: outcome?.kind === 'failed' ? structuredClone(outcome.error) : null,
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

  selectCandidate({ projectId, generationId, candidateId }) {
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

    const revision = {
      id: this.#idFactory('revision'),
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
    project.activeRevisionId = this.#revisions.get(revision.id).id;
    project.updatedAt = this.#now();
    return clone(revision);
  }

  getProject(projectId) {
    return clone(this.#requireProject(projectId));
  }

  getGeneration(generationId) {
    return clone(this.#requireGeneration(generationId));
  }

  getRevision(revisionId) {
    const revision = this.#requireRevision(revisionId);
    return clone(revision);
  }

  listRevisions(projectId) {
    this.#requireProject(projectId);
    return [...this.#revisions.values()]
      .filter((revision) => revision.projectId === projectId)
      .map(clone);
  }

  listGenerations(projectId) {
    this.#requireProject(projectId);
    return [...this.#generations.values()]
      .filter((generation) => generation.projectId === projectId)
      .map(clone);
  }

  #requireProject(projectId) {
    const project = this.#projects.get(projectId);
    if (!project) {
      throw new ProjectNotFoundError(projectId);
    }
    return project;
  }

  #requireGeneration(generationId) {
    const generation = this.#generations.get(generationId);
    if (!generation) {
      throw new GenerationNotFoundError(generationId);
    }
    return generation;
  }

  #requireRevision(revisionId) {
    const revision = this.#revisions.get(revisionId);
    if (!revision) {
      throw new RevisionNotFoundError(revisionId);
    }
    return revision;
  }

  #assertGenerationBelongsToProject(generation, projectId) {
    if (generation.projectId !== projectId) {
      throw new CandidateSelectionError(
        `Generation ${generation.id} does not belong to project ${projectId}`,
      );
    }
  }

  #handleRepeatedSelection(generation, candidateId) {
    if (generation.selectedCandidateId !== candidateId) {
      throw new CandidateSelectionError(
        `Generation ${generation.id} already selected candidate ${generation.selectedCandidateId}`,
      );
    }

    return this.getRevision(generation.selectedRevisionId);
  }
}

function clone(value) {
  return structuredClone(value);
}
