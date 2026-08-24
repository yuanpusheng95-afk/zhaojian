import assert from 'node:assert/strict';
import { describe, expect, test } from 'bun:test';

import {
  PatchConflictError,
  UnsafeStatePathError,
  applyPhotoStatePatch,
} from '../src/domain/photo-state.js';

function baseState() {
  return {
    subject: {
      personId: 'person_1',
      identity: { preserve: true },
      hair: { preserve: false },
    },
    scene: {
      location: 'studio',
      mood: 'neutral',
    },
    appearance: {
      outfit: 'black jacket',
      makeup: 'natural',
    },
    composition: {
      shot: 'medium',
      cameraAngle: 'eye-level',
    },
    constraints: [],
  };
}

test('applies modify operations without mutating the base state', () => {
  const state = baseState();

  const next = applyPhotoStatePatch(state, {
    modify: [
      {
        path: 'appearance.outfit',
        operation: 'replace',
        value: 'ivory coat',
      },
    ],
    preserve: [],
  });

  assert.equal(next.appearance.outfit, 'ivory coat');
  assert.equal(state.appearance.outfit, 'black jacket');
  assert.notStrictEqual(next, state);
  assert.notStrictEqual(next.appearance, state.appearance);
});

test('merges preserve constraints by path instead of duplicating them', () => {
  const state = baseState();
  state.constraints.push({
    path: 'subject.identity',
    strength: 'soft',
    source: 'system',
  });

  const next = applyPhotoStatePatch(state, {
    modify: [],
    preserve: [
      { path: 'subject.identity', strength: 'hard' },
      { path: 'scene.background', strength: 'hard' },
    ],
  });

  assert.deepEqual(next.constraints, [
    { path: 'subject.identity', strength: 'hard', source: 'user' },
    { path: 'scene.background', strength: 'hard', source: 'user' },
  ]);
});

test('rejects a path that is modified and preserved in the same patch', () => {
  const state = baseState();

  assert.throws(
    () =>
      applyPhotoStatePatch(state, {
        modify: [
          {
            path: 'appearance.outfit',
            operation: 'replace',
            value: 'ivory coat',
          },
        ],
        preserve: [{ path: 'appearance.outfit', strength: 'hard' }],
      }),
    PatchConflictError,
  );
});

test('rejects prototype-polluting state paths', () => {
  const state = baseState();

  assert.throws(
    () =>
      applyPhotoStatePatch(state, {
        modify: [
          {
            path: '__proto__.polluted',
            operation: 'replace',
            value: true,
          },
        ],
        preserve: [],
      }),
    UnsafeStatePathError,
  );

  assert.equal({}.polluted, undefined);
});

test('rejects modify paths outside the V1 photo state schema', () => {
  const state = baseState();

  assert.throws(
    () =>
      applyPhotoStatePatch(state, {
        modify: [
          {
            path: 'appearance.internalFlag',
            operation: 'replace',
            value: true,
          },
        ],
        preserve: [],
      }),
    UnsafeStatePathError,
  );
});

test('rejects modify and preserve paths that overlap by ancestry', () => {
  const state = baseState();

  assert.throws(
    () =>
      applyPhotoStatePatch(state, {
        modify: [
          {
            path: 'composition.shot',
            operation: 'replace',
            value: 'close-up',
          },
        ],
        preserve: [{ path: 'composition', strength: 'hard' }],
      }),
    PatchConflictError,
  );
});
