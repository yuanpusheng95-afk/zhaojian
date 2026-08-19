import { applyPhotoStatePatch } from '../domain/photo-state.mjs';

export class InvalidEditRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidEditRequestError';
    this.code = 'INVALID_EDIT_REQUEST';
  }
}

export class EditInterpretationFailedError extends Error {
  constructor(cause) {
    super('Language model could not produce a valid photo state patch', {
      cause,
    });
    this.name = 'EditInterpretationFailedError';
    this.code = 'EDIT_INTERPRETATION_FAILED';
  }
}

export class EditInterpreter {
  #repository;
  #languageModel;

  constructor({ repository, languageModel }) {
    requireRepository(repository);
    requireLanguageModel(languageModel);
    this.#repository = repository;
    this.#languageModel = languageModel;
  }

  async interpretAndRequestGeneration({
    projectId,
    baseRevisionId,
    idempotencyKey,
    message,
  }) {
    if (typeof message !== 'string' || message.trim() === '') {
      throw new InvalidEditRequestError(
        'Edit request requires a non-empty message',
      );
    }

    const revision = await this.#repository.getRevision(baseRevisionId);
    let patch;
    try {
      patch = await this.#languageModel.planPatch({
        message,
        photoState: structuredClone(revision.state),
      });
      applyPhotoStatePatch(revision.state, patch);
    } catch (error) {
      throw new EditInterpretationFailedError(error);
    }

    return this.#repository.requestGeneration({
      projectId,
      baseRevisionId,
      idempotencyKey,
      patch,
      operation: 'edit',
    });
  }
}

function requireRepository(repository) {
  if (
    typeof repository?.getRevision !== 'function' ||
    typeof repository.requestGeneration !== 'function'
  ) {
    throw new TypeError(
      'Edit interpreter repository must implement getRevision() and requestGeneration()',
    );
  }
}

function requireLanguageModel(languageModel) {
  if (
    languageModel?.capability !== 'language' ||
    typeof languageModel.planPatch !== 'function'
  ) {
    throw new TypeError(
      'Language model must implement capability and planPatch()',
    );
  }
}
