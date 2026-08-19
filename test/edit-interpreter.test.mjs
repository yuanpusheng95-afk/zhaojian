import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EditInterpretationFailedError,
  EditInterpreter,
  InvalidEditRequestError,
} from '../src/application/edit-interpreter.mjs';
import {
  IdempotencyConflictError,
  ProjectBusyError,
  RevisionConflictError,
} from '../src/domain/photo-project-service.mjs';

function initialState() {
  return {
    subject: {
      personId: 'person_1',
      identity: { preserve: true },
    },
    scene: { location: 'studio', background: 'gray' },
    appearance: { outfit: 'black jacket' },
    composition: { shot: 'medium' },
    constraints: [],
  };
}

function editPatch(value = 'ivory coat') {
  return {
    modify: [
      {
        path: 'appearance.outfit',
        operation: 'replace',
        value,
      },
    ],
    preserve: [
      { path: 'subject.identity', strength: 'hard' },
      { path: 'scene.background', strength: 'hard' },
    ],
  };
}

function createRepository({ requestError = null } = {}) {
  const revision = {
    id: 'revision_1',
    projectId: 'project_1',
    state: initialState(),
  };
  const calls = [];

  return {
    revision,
    calls,
    async getRevision(revisionId) {
      calls.push(['getRevision', revisionId]);
      return structuredClone(revision);
    },
    async requestGeneration(input) {
      calls.push(['requestGeneration', structuredClone(input)]);
      if (requestError) throw requestError;
      return {
        id: 'generation_1',
        status: 'queued',
        patch: structuredClone(input.patch),
      };
    },
  };
}

function createLanguageModel(planner) {
  return {
    capability: 'language',
    planPatch: planner,
  };
}

test('edit interpreter plans a patch from revision state and requests a generation', async () => {
  const repository = createRepository();
  let modelInput;
  const patch = editPatch();
  const interpreter = new EditInterpreter({
    repository,
    languageModel: createLanguageModel(async (input) => {
      modelInput = input;
      input.photoState.scene.location = 'mutated by adapter';
      return patch;
    }),
  });

  const generation = await interpreter.interpretAndRequestGeneration({
    projectId: 'project_1',
    baseRevisionId: 'revision_1',
    idempotencyKey: 'message_1',
    message: '把外套改成象牙白，保持脸和背景',
  });

  assert.equal(generation.id, 'generation_1');
  assert.equal(modelInput.message, '把外套改成象牙白，保持脸和背景');
  assert.deepEqual(modelInput.photoState.appearance, {
    outfit: 'black jacket',
  });
  assert.equal(repository.revision.state.scene.location, 'studio');
  assert.deepEqual(repository.calls, [
    ['getRevision', 'revision_1'],
    [
      'requestGeneration',
      {
        projectId: 'project_1',
        baseRevisionId: 'revision_1',
        idempotencyKey: 'message_1',
        patch,
        operation: 'edit',
      },
    ],
  ]);
});

test('edit interpreter rejects an empty message before reading state', async () => {
  const repository = createRepository();
  const interpreter = new EditInterpreter({
    repository,
    languageModel: createLanguageModel(async () => editPatch()),
  });

  await assert.rejects(
    interpreter.interpretAndRequestGeneration({
      projectId: 'project_1',
      baseRevisionId: 'revision_1',
      idempotencyKey: 'message_empty',
      message: '   ',
    }),
    InvalidEditRequestError,
  );
  assert.deepEqual(repository.calls, []);
});

test('edit interpreter rejects an image generation provider', () => {
  const repository = createRepository();

  assert.throws(
    () =>
      new EditInterpreter({
        repository,
        languageModel: {
          capability: 'image_generation',
          async planPatch() {
            return editPatch();
          },
        },
      }),
    /Language model must implement capability and planPatch/,
  );
});

test('edit interpreter wraps language model failures without creating a generation', async () => {
  const repository = createRepository();
  const providerError = new Error('upstream unavailable');
  const interpreter = new EditInterpreter({
    repository,
    languageModel: createLanguageModel(async () => {
      throw providerError;
    }),
  });

  await assert.rejects(
    interpreter.interpretAndRequestGeneration({
      projectId: 'project_1',
      baseRevisionId: 'revision_1',
      idempotencyKey: 'message_failure',
      message: '换一件白色外套',
    }),
    (error) => {
      assert.ok(error instanceof EditInterpretationFailedError);
      assert.equal(error.code, 'EDIT_INTERPRETATION_FAILED');
      assert.equal(error.cause, providerError);
      return true;
    },
  );
  assert.equal(
    repository.calls.some(([name]) => name === 'requestGeneration'),
    false,
  );
});

for (const [name, patch] of [
  ['unsupported path', {
    modify: [
      { path: 'billing.plan', operation: 'replace', value: 'premium' },
    ],
    preserve: [],
  }],
  ['unsafe path', {
    modify: [
      { path: '__proto__.polluted', operation: 'replace', value: true },
    ],
    preserve: [],
  }],
  ['modify preserve conflict', {
    modify: [
      {
        path: 'appearance.outfit',
        operation: 'replace',
        value: 'white coat',
      },
    ],
    preserve: [{ path: 'appearance.outfit', strength: 'hard' }],
  }],
]) {
  test(`edit interpreter rejects ${name} from the language model`, async () => {
    const repository = createRepository();
    const interpreter = new EditInterpreter({
      repository,
      languageModel: createLanguageModel(async () => patch),
    });

    await assert.rejects(
      interpreter.interpretAndRequestGeneration({
        projectId: 'project_1',
        baseRevisionId: 'revision_1',
        idempotencyKey: `message_${name}`,
        message: '修改照片',
      }),
      EditInterpretationFailedError,
    );
    assert.equal(
      repository.calls.some(([call]) => call === 'requestGeneration'),
      false,
    );
  });
}

for (const error of [
  new RevisionConflictError({
    projectId: 'project_1',
    expectedRevisionId: 'revision_1',
    actualRevisionId: 'revision_2',
  }),
  new ProjectBusyError('project_1', 'generation_running'),
  new IdempotencyConflictError('project_1', 'message_conflict'),
]) {
  test(`edit interpreter preserves repository error ${error.code}`, async () => {
    const repository = createRepository({ requestError: error });
    const interpreter = new EditInterpreter({
      repository,
      languageModel: createLanguageModel(async () => editPatch()),
    });

    await assert.rejects(
      interpreter.interpretAndRequestGeneration({
        projectId: 'project_1',
        baseRevisionId: 'revision_1',
        idempotencyKey: 'message_conflict',
        message: '换一件白色外套',
      }),
      (received) => received === error,
    );
  });
}
