import assert from 'node:assert/strict';
import { describe, expect, test } from 'bun:test';

import { createAgentTurnWorker } from '../src/worker/agent-turn-worker.js';
import { createFakeStreamFn } from './support/fake-stream-fn.mjs';
import { runAgentTurn } from '../src/agent/agent-runner.js';
import { InMemorySessionRepo, SessionError } from '@earendil-works/pi-agent-core';

const config = {
  llm: { baseUrl: 'https://llm.test', modelId: 'fake-model' },
  guards: { turnTimeoutMs: 1000 },
  heartbeatMs: 1,
};

function createQueue() {
  const turns = new Map();
  let order = [];
  return {
    turns,
    request({ turnId, projectId = 'project_1', userMessage = 'work' }) {
      const turn = { turnId, projectId, userMessage, status: 'queued', leaseToken: null };
      turns.set(turnId, turn);
      order.push(turnId);
    },
    async failExpiredTurns() { return 0; },
    async claimNextTurn() {
      const turnId = order.shift();
      if (!turnId) return null;
      const turn = turns.get(turnId);
      turn.status = 'running';
      turn.leaseToken = `lease_${turnId}`;
      return { turnId, projectId: turn.projectId, userMessage: turn.userMessage, leaseToken: turn.leaseToken };
    },
    async renewTurnLease({ turnId, leaseToken }) {
      const turn = turns.get(turnId);
      if (turn?.leaseToken !== leaseToken || turn.status !== 'running') {
        throw Object.assign(new Error('lost'), { code: 'TURN_LEASE_LOST' });
      }
      turn.renewed = (turn.renewed ?? 0) + 1;
    },
    async finishTurn({ turnId, leaseToken, status, error }) {
      const turn = turns.get(turnId);
      if (turn.leaseToken !== leaseToken) throw Object.assign(new Error('lost'), { code: 'TURN_LEASE_LOST' });
      turn.status = status;
      turn.error = error;
      turn.finished = true;
      return { turnId, status };
    },
  };
}

function sessionRepo() {
  const repo = new InMemorySessionRepo();
  return {
    open: async ({ id }) => repo.open({ id }).catch((error) => {
      if (error?.code !== 'not_found') throw error;
      return repo.create({ id });
    }),
    create: async ({ id }) => repo.create({ id }),
  };
}

test('worker completes a full turn and finishes it', async () => {
  const queue = createQueue();
  queue.request({ turnId: 'turn_1' });
  const worker = createAgentTurnWorker({
    queue,
    config,
    runTurn: async (turn, signal) => {
      assert.ok(signal);
      return { kind: 'completed' };
    },
  });
  await worker.runOnce();
  assert.equal(queue.turns.get('turn_1').status, 'completed');
  assert.ok(queue.turns.get('turn_1').finished);
  assert.equal(worker.inFlightCount, 0);
});

test('worker marks fatal outcomes as failed', async () => {
  const queue = createQueue();
  queue.request({ turnId: 'turn_fatal' });
  const worker = createAgentTurnWorker({
    queue,
    config,
    runTurn: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { kind: 'failed', fatal: { code: 'IMAGE_PROVIDER_UNAUTHORIZED', message: '401' } };
    },
  });
  await worker.runOnce();
  const turn = queue.turns.get('turn_fatal');
  assert.equal(turn.status, 'failed');
  assert.equal(turn.error.code, 'IMAGE_PROVIDER_UNAUTHORIZED');
});

test('worker does not finish a turn after its lease is lost', async () => {
  const queue = createQueue();
  queue.request({ turnId: 'turn_lost' });
  const worker = createAgentTurnWorker({
    queue,
    config,
    runTurn: async (turn, signal) => {
      const turnRecord = queue.turns.get(turn.turnId);
      turnRecord.leaseToken = 'other';
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { kind: 'completed' };
    },
  });
  await worker.runOnce();
  const turn = queue.turns.get('turn_lost');
  assert.equal(turn.status, 'running');
  assert.ok(!turn.finished);
});

test('worker stop prevents new claims and waitUntilIdle waits for work', async () => {
  const queue = createQueue();
  queue.request({ turnId: 'turn_1' });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const worker = createAgentTurnWorker({
    queue,
    config,
    runTurn: async () => {
      await gate;
      return { kind: 'completed' };
    },
  });
  const execution = worker.runOnce();
  worker.stop();
  release();
  await worker.waitUntilIdle();
  await execution;
  assert.equal(worker.stopped, true);
  const second = await worker.runOnce();
  assert.equal(second, null);
});

test('aborted turns forward the run error to finishTurn', async () => {
  const queue = createQueue();
  queue.request({ turnId: 'turn_abort' });
  const worker = createAgentTurnWorker({
    queue,
    runTurn: async () => ({ kind: 'aborted', error: { code: 'TURN_TIMEOUT', message: 'Turn timed out' } }),
    config,
  });

  await worker.runOnce();

  const turn = queue.turns.get('turn_abort');
  assert.equal(turn.status, 'aborted');
  assert.equal(turn.error.code, 'TURN_TIMEOUT');
});
