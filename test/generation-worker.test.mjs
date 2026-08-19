import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GenerationLeaseLostError } from '../src/infrastructure/postgres/photo-project-repository.mjs';
import { GenerationWorker } from '../src/worker/generation-worker.mjs';

function createHarness({ renewError = null, providerJobId = null } = {}) {
  const calls = [];
  let heartbeat;
  let status = 'preparing';
  const claimed = {
    id: 'generation_1',
    status,
    leaseToken: 'lease_1',
    providerName: providerJobId ? 'mock' : null,
    providerJobId,
    providerSubmittedAt: providerJobId
      ? '2026-08-19T06:39:00.000Z'
      : null,
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
      return {
        ...claimed,
        status,
        candidates: status === 'completed' ? [{}] : [],
      };
    },
    async recordProviderJob(input) {
      calls.push(['recordProviderJob', input]);
      return {
        providerName: input.providerName,
        providerJobId: input.providerJobId,
      };
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
    name: 'mock',
    async submit(input) {
      calls.push(['submit', input]);
      return { jobId: 'provider_job_1' };
    },
    async waitForResult(input) {
      calls.push(['waitForResult', input]);
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

test('worker submits with a stable idempotency key, persists the provider job, and waits for it', async () => {
  const { calls, worker } = createHarness();

  const completed = await worker.runOnce();

  assert.equal(completed.status, 'completed');
  const submit = calls.find(([name]) => name === 'submit');
  assert.equal(submit[1].idempotencyKey, 'generation_1');
  assert.equal(submit[1].generation.id, 'generation_1');
  assert.deepEqual(calls.find(([name]) => name === 'recordProviderJob'), [
    'recordProviderJob',
    {
      generationId: 'generation_1',
      claimToken: 'lease_1',
      providerName: 'mock',
      providerJobId: 'provider_job_1',
    },
  ]);
  assert.equal(
    calls.find(([name]) => name === 'waitForResult')[1].jobId,
    'provider_job_1',
  );
  const writes = calls.filter(([name]) =>
    ['transitionGeneration', 'recordProviderJob', 'addCandidate'].includes(name),
  );
  assert.ok(writes.every(([, input]) => input.claimToken === 'lease_1'));
  assert.ok(calls.some(([name]) => name === 'renewLease'));
});

test('worker resumes a persisted provider job without submitting it again', async () => {
  const { calls, worker } = createHarness({
    providerJobId: 'provider_job_existing',
  });

  const completed = await worker.runOnce();

  assert.equal(completed.status, 'completed');
  assert.equal(calls.some(([name]) => name === 'submit'), false);
  assert.equal(calls.some(([name]) => name === 'recordProviderJob'), false);
  assert.equal(
    calls.find(([name]) => name === 'waitForResult')[1].jobId,
    'provider_job_existing',
  );
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
