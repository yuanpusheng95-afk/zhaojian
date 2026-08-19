import { randomUUID } from 'node:crypto';

import {
  GENERATION_TRANSITIONS,
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

export class InvalidGenerationRequestError extends DomainError {
  constructor(message) {
    super(message, 'INVALID_GENERATION_REQUEST');
  }
}

export class IdempotencyConflictError extends DomainError {
  constructor(projectId, idempotencyKey) {
    super(
      `Idempotency key ${idempotencyKey} was reused with a different request in project ${projectId}`,
      'IDEMPOTENCY_CONFLICT',
    );
    this.projectId = projectId;
    this.idempotencyKey = idempotencyKey;
  }
}

export class ProjectBusyError extends DomainError {
  constructor(projectId, generationId) {
    super(
      `Project ${projectId} already has an active generation: ${generationId}`,
      'PROJECT_BUSY',
    );
    this.projectId = projectId;
    this.generationId = generationId;
  }
}

export class GenerationTransitionError extends DomainError {
  constructor(generationId, from, to) {
    super(
      `Invalid generation transition for ${generationId}: ${from} -> ${to}`,
      'INVALID_GENERATION_TRANSITION',
    );
    this.generationId = generationId;
    this.from = from;
    this.to = to;
  }
}

export class CandidateSelectionError extends DomainError {
  constructor(message) {
    super(message, 'CANDIDATE_SELECTION_ERROR');
  }
}

export class PhotoProjectService {
  #projects = new Map();
  #revisions = new Map();
  #generations = new Map();
  #idempotency = new Map();
  #idFactory;
  #now;

  constructor({
    idFactory = (prefix) => `${prefix}_${randomUUID()}`,
    now = () => new Date().toISOString(),
  } = {}) {
    this.#idFactory = idFactory;
    this.#now = now;
  }

  createProject({ projectId, name, initialState, anchorAssetId = null }) {
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
      anchorAssetId,
      sourceGenerationId: null,
      createdAt,
    };
    const project = {
      id,
      name,
      activeRevisionId: revision.id,
      runningGenerationId: null,
      createdAt,
      updatedAt: createdAt,
    };

    this.#projects.set(id, project);
    this.#revisions.set(revision.id, revision);
    return clone(project);
  }

  requestGeneration({
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

    const project = this.#requireProject(projectId);
    const idempotencyId = `${projectId}:${idempotencyKey}`;
    const requestFingerprint = canonicalStringify({
      baseRevisionId,
      operation,
      patch,
    });
    const existingRequest = this.#idempotency.get(idempotencyId);
    if (existingRequest) {
      if (existingRequest.fingerprint !== requestFingerprint) {
        throw new IdempotencyConflictError(projectId, idempotencyKey);
      }
      return this.getGeneration(existingRequest.generationId);
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

    const baseRevision = this.#revisions.get(baseRevisionId);
    const generation = {
      id: this.#idFactory('generation'),
      projectId,
      inputRevisionId: baseRevisionId,
      operation,
      idempotencyKey,
      patch: structuredClone(patch),
      proposedState: applyPhotoStatePatch(baseRevision.state, patch),
      status: 'queued',
      candidates: [],
      selectedCandidateId: null,
      selectedRevisionId: null,
      createdAt: this.#now(),
      updatedAt: this.#now(),
    };

    this.#generations.set(generation.id, generation);
    this.#idempotency.set(idempotencyId, {
      generationId: generation.id,
      fingerprint: requestFingerprint,
    });
    project.runningGenerationId = generation.id;
    project.updatedAt = generation.updatedAt;
    return clone(generation);
  }

  transitionGeneration({ generationId, to }) {
    const generation = this.#requireGeneration(generationId);
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

    generation.status = to;
    generation.updatedAt = this.#now();

    if (TERMINAL_GENERATION_STATUSES.has(to)) {
      this.#releaseProjectGeneration(generation);
    }

    return clone(generation);
  }

  addCandidate({ generationId, candidateId, assetId, verification = {} }) {
    const generation = this.#requireGeneration(generationId);
    if (generation.status !== 'verifying') {
      throw new GenerationTransitionError(
        generationId,
        generation.status,
        'add_candidate',
      );
    }

    if (generation.candidates.some(({ id }) => id === candidateId)) {
      throw new CandidateSelectionError(
        `Candidate already exists: ${candidateId}`,
      );
    }

    const candidate = {
      id: candidateId ?? this.#idFactory('candidate'),
      assetId,
      verification: structuredClone(verification),
      createdAt: this.#now(),
    };
    generation.candidates.push(candidate);
    generation.updatedAt = this.#now();
    return clone(candidate);
  }

  selectCandidate({ projectId, generationId, candidateId }) {
    const project = this.#requireProject(projectId);
    const generation = this.#requireGeneration(generationId);
    this.#assertGenerationBelongsToProject(generation, projectId);

    if (generation.selectedCandidateId) {
      return this.#handleRepeatedSelection(generation, candidateId);
    }

    if (
      project.runningGenerationId &&
      project.runningGenerationId !== generation.id
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
    project.activeRevisionId = revision.id;
    project.updatedAt = generation.updatedAt;
    return clone(revision);
  }

  getProject(projectId) {
    return clone(this.#requireProject(projectId));
  }

  getGeneration(generationId) {
    return clone(this.#requireGeneration(generationId));
  }

  getRevision(revisionId) {
    const revision = this.#revisions.get(revisionId);
    if (!revision) {
      throw new DomainError(`Revision not found: ${revisionId}`, 'REVISION_NOT_FOUND');
    }
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

  #releaseProjectGeneration(generation) {
    const project = this.#requireProject(generation.projectId);
    if (project.runningGenerationId === generation.id) {
      project.runningGenerationId = null;
      project.updatedAt = generation.updatedAt;
    }
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

function canonicalStringify(value) {
  return JSON.stringify(sortObject(value));
}

function sortObject(value) {
  if (Array.isArray(value)) {
    return value.map(sortObject);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortObject(value[key])]),
  );
}
