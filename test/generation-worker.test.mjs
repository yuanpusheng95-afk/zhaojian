import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GenerationLeaseLostError } from '../src/infrastructure/postgres/photo-project-repository.mjs';
import { GenerationWorker } from '../src/worker/generation-worker.mjs';

function createHarness({ renewError = null } = {}) {
  const calls = [];
  let heartbeat;
  let status = 'preparing';
  const claimed = {
    id: 'generation_1',
    status,
    leaseToken: 'lease_1',
  };
  const queue = {
    async claimNext() {
      return claimed;
    },
    async renewLease(input) {
      calls.push(['renewLease', input]);
      if (renewError) throw renewError;
      return { ...input, leaseExpiresAt: '2026-08-19T06:40:30.000Z' };
    },
  };
  const repository = {
    async transitionGeneration(input) {
      calls.push(['transitionGeneration', input]);
      status = input.to;
      return { ...claimed, status, candidates: status === 'completed' ? [{}] : [] };
    },
    async addCandidate(input) {
      calls.push(['addCandidate', input]);
      return input;
    },
    async getGeneration() {
      calls.push(['getGeneration']);
      return { ...claimed, status, candidates: [] };
    },
  };
  const provider = {
    async generate() {
      await heartbeat();
      return [{ candidateId: 'candidate_1', assetId: 'asset_1' }];
    },
  };
  const worker = new GenerationWorker({
    queue,
    repository,
    provider,
    heartbeatIntervalMs: 10,
    setIntervalFn(callback) {
      heartbeat = callback;
      return 'timer_1';
    },
    clearIntervalFn(timerId) {
      calls.push(['clearInterval', timerId]);
    },
  });
  return { calls, worker };
}

test('worker carries the claim token through writes and renews during provider work', async () => {
  const { calls, worker } = createHarness();

  const completed = await worker.runOnce();

  assert.equal(completed.status, 'completed');
  const writes = calls.filter(([name]) =>
    ['transitionGeneration', 'addCandidate'].includes(name),
  );
  assert.ok(writes.length > 0);
  assert.ok(writes.every(([, input]) => input.claimToken === 'lease_1'));
  assert.deepEqual(calls.find(([name]) => name === 'renewLease'), [
    'renewLease',
    { generationId: 'generation_1', claimToken: 'lease_1' },
  ]);
  assert.deepEqual(calls.find(([name]) => name === 'clearInterval'), [
    'clearInterval',
    'timer_1',
  ]);
});

test('worker stops writing and does not fail a generation after losing its lease', async () => {
  const { calls, worker } = createHarness({
    renewError: new GenerationLeaseLostError('generation_1'),
  });

  const current = await worker.runOnce();

  assert.equal(current.status, 'provider_processing');
  assert.deepEqual(
    calls
      .filter(([name]) => name === 'transitionGeneration')
      .map(([, input]) => input.to),
    ['submitted', 'provider_processing'],
  );
  assert.equal(calls.some(([name]) => name === 'addCandidate'), false);
  assert.equal(calls.filter(([name]) => name === 'getGeneration').length, 1);
});
