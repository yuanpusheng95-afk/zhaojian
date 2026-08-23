import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import http from 'node:http';

import { IdempotencyConflictError, ProjectBusyError } from '../src/infrastructure/postgres/agent-turn-queue.mjs';
import { handleTurnEvents, parsePollMs } from '../src/api/sse.mjs';
import { createApiServer } from '../src/api/server.mjs';

function startServer(dependencies) {
  const server = createApiServer(dependencies);
  return new Promise((resolve) => {
    server.listen(0, () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

function fakeQueue() {
  return {
    async requestTurn({ projectId, userMessage, idempotencyKey }) {
      if (idempotencyKey === 'conflict') throw new IdempotencyConflictError(projectId, idempotencyKey);
      if (idempotencyKey === 'busy') throw new ProjectBusyError(projectId, 'turn_old');
      return { turnId: `turn_${userMessage}`, replayed: idempotencyKey === 'replay' };
    },
  };
}

function fakeViews(detail) {
  return {
    async loadTurnDetail(input) {
      if (input.turnId === 'missing') {
        const error = new Error('not found');
        error.code = 'TURN_NOT_FOUND';
        throw error;
      }
      return detail;
    },
    async turnChangedSince() {
      return { changed: true, fingerprint: 'same' };
    },
    assertTurnExists({ projectId, turnId }) {
      if (turnId === 'missing') {
        const error = new Error('not found');
        error.code = 'TURN_NOT_FOUND';
        throw error;
      }
      return { projectId, turnId };
    },
  };
}

function recordingViews(detail) {
  const calls = [];
  return {
    calls,
    async loadTurnDetail(input) {
      calls.push(input);
      return detail;
    },
    async turnChangedSince() {
      return { changed: true, fingerprint: `f${calls}` };
    },
    assertTurnExists({ projectId, turnId }) {
      calls.push({ projectId, turnId });
    },
  };
}

function fakeRepository({ selectionError } = {}) {
  return {
    async selectCandidate({ projectId, generationId, candidateId }) {
      if (selectionError === 'cross') {
        const error = new Error(`Generation ${generationId} does not belong to project ${projectId}`);
        error.code = 'CANDIDATE_SELECTION_ERROR';
        throw error;
      }
      if (selectionError === 'conflict') {
        const error = new Error('already selected');
        error.code = 'CANDIDATE_SELECTION_ERROR';
        throw error;
      }
      return { id: `revision_${candidateId}` };
    },
  };
}

test('message routes expose idempotent turn creation states', async () => {
  const dependencies = { repository: fakeRepository(), queue: fakeQueue(), turnViews: fakeViews({}) };
  const { server, url } = await startServer(dependencies);

  const created = await fetch(`${url}/projects/p1/messages`, {
    method: 'POST',
    headers: { 'idempotency-key': 'new' },
    body: JSON.stringify({ message: 'hello' }),
  });
  assert.equal(created.status, 202);
  assert.deepEqual(await created.json(), { turnId: 'turn_hello', replayed: false });

  const replayed = await fetch(`${url}/projects/p1/messages`, {
    method: 'POST',
    headers: { 'idempotency-key': 'replay' },
    body: JSON.stringify({ message: 'hello' }),
  });
  assert.equal(replayed.status, 200);

  const missingKey = await fetch(`${url}/projects/p1/messages`, {
    method: 'POST',
    body: JSON.stringify({ message: 'hello' }),
  });
  assert.equal(missingKey.status, 400);
  const emptyMessage = await fetch(`${url}/projects/p1/messages`, {
    method: 'POST',
    headers: { 'idempotency-key': 'empty' },
    body: JSON.stringify({ message: '   ' }),
  });
  assert.equal(emptyMessage.status, 400);
  assert.equal((await emptyMessage.json()).error.code, 'INVALID_MESSAGE');
  server.close();
});

test('selection route atomically delegates and maps errors', async () => {
  const views = recordingViews({ status: 'completed' });
  const good = { repository: fakeRepository(), queue: fakeQueue(), turnViews: views };
  const first = await startServer(good);
  const selected = await fetch(`${first.url}/projects/p1/turns/t1/selections`, {
    method: 'POST',
    body: JSON.stringify({ generationId: 'g1', candidateId: 'c1' }),
  });
  assert.equal(selected.status, 200);
  assert.deepEqual(await selected.json(), { revisionId: 'revision_c1' });
  assert.deepEqual(views.calls, [{ projectId: 'p1', turnId: 't1' }]);
  first.server.close();

  const bad = {
    repository: fakeRepository({ selectionError: 'cross' }),
    queue: fakeQueue(),
    turnViews: recordingViews({ status: 'completed' }),
  };
  const second = await startServer(bad);
  const rejected = await fetch(`${second.url}/projects/p2/turns/t1/selections`, {
    method: 'POST',
    body: JSON.stringify({ generationId: 'g1', candidateId: 'c1' }),
  });
  assert.equal(rejected.status, 409);
  second.server.close();

  const missingTurn = {
    repository: fakeRepository(),
    queue: fakeQueue(),
    turnViews: fakeViews({}),
  };
  const third = await startServer(missingTurn);
  const missing = await fetch(`${third.url}/projects/p1/turns/missing/selections`, {
    method: 'POST',
    body: JSON.stringify({ generationId: 'g1', candidateId: 'c1' }),
  });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'TURN_NOT_FOUND');
  third.server.close();

  const invalid = {
    repository: fakeRepository(),
    queue: fakeQueue(),
    turnViews: recordingViews({ status: 'completed', generations: [] }),
  };
  const fourth = await startServer(invalid);
  const response = await fetch(`${fourth.url}/projects/p1/turns/t1/selections`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'INVALID_SELECTION');
  fourth.server.close();
});

test('turn detail and queue errors map to stable HTTP codes', async () => {
  const dependencies = { repository: fakeRepository(), queue: fakeQueue(), turnViews: fakeViews({
    status: 'running', generations: [],
  }) };
  const { server, url } = await startServer(dependencies);
  const detail = await fetch(`${url}/projects/p1/turns/t1`);
  assert.equal(detail.status, 200);
  const missing = await fetch(`${url}/projects/p1/turns/missing`);
  assert.equal(missing.status, 404);
  const conflict = await fetch(`${url}/projects/p1/messages`, {
    method: 'POST', headers: { 'idempotency-key': 'conflict' }, body: JSON.stringify({ message: 'x' }),
  });
  assert.equal(conflict.status, 409);
  const busy = await fetch(`${url}/projects/p1/messages`, {
    method: 'POST', headers: { 'idempotency-key': 'busy' }, body: JSON.stringify({ message: 'x' }),
  });
  assert.equal(busy.status, 409);
  server.close();
});

test('pollMs is clamped to the documented floor', () => {
  assert.equal(parsePollMs('10'), 250);
  assert.equal(parsePollMs(null), 1000);
  assert.equal(parsePollMs('500'), 500);
});

test('SSE sends the current terminal turn and closes immediately', async () => {
  const chunks = [];
  const response = {
    writeHead() {},
    write(chunk) {
      chunks.push(chunk);
      return true;
    },
    end() {},
  };
  const request = { on() {} };

  await handleTurnEvents({
    request,
    response,
    turnViews: fakeViews({ status: 'completed', generations: [] }),
    projectId: 'project_1',
    turnId: 'turn_1',
    pollMs: '250',
  });

  const events = chunks.join('').split('\n\n').filter(Boolean);
  assert.equal(events[0], ': ping');
  assert.match(events[1], /^event: turn\ndata: /);
  assert.equal(events[2], 'event: done\ndata: {}');
});

test('SSE polls until the turn becomes terminal and cleans timers on close', async () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const intervals = [];
  const timeouts = [];
  let intervalCleared = false;
  let timeoutCleared = false;
  let closed = false;

  globalThis.setInterval = (callback, delay) => {
    intervals.push({ callback, delay });
    return 101;
  };
  globalThis.clearInterval = () => {
    intervalCleared = true;
  };
  globalThis.setTimeout = (callback, delay) => {
    timeouts.push({ callback, delay });
    return 202;
  };
  globalThis.clearTimeout = () => {
    timeoutCleared = true;
  };

  try {
    const chunks = [];
    const listeners = new Map();
    const response = {
      writeHead() {},
      write(chunk) {
        chunks.push(chunk);
        return true;
      },
      end() {
        closed = true;
      },
      destroy() {
        closed = true;
      },
    };
    const request = {
      on(event, callback) {
        listeners.set(event, callback);
      },
    };
    let calls = 0;
    const views = {
      async loadTurnDetail() {
        calls += 1;
        return { status: calls === 1 ? 'running' : 'completed', generations: [] };
      },
      async turnChangedSince() {
        return { changed: true, fingerprint: `f${calls}` };
      },
    };

    await handleTurnEvents({
      request,
      response,
      turnViews: views,
      projectId: 'project_1',
      turnId: 'turn_1',
      pollMs: '250',
    });
    assert.equal(timeouts.length, 1);
    assert.equal(timeouts[0].delay, 250);
    await Promise.resolve().then(timeouts[0].callback).catch(() => {});

    assert.match(chunks.join(''), /"status":"running"/);
    assert.match(chunks.join(''), /event: done\ndata: \{\}/);
    assert.equal(closed, true);
    assert.equal(intervalCleared, true);
    assert.equal(timeoutCleared, true);

    listeners.get('close')();
    assert.equal(intervalCleared, true);
    assert.equal(timeoutCleared, true);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('SSE emits an error event when views reject', async () => {
  const chunks = [];
  const response = {
    writeHead() {},
    write(chunk) {
      chunks.push(chunk);
      return true;
    },
    end() {},
  };
  const request = { on() {} };
  const views = {
    async turnChangedSince() {
      const error = new Error('turn exploded');
      error.code = 'TURN_NOT_FOUND';
      throw error;
    },
    async loadTurnDetail() {
      throw new Error('detail should not be loaded');
    },
  };

  await handleTurnEvents({
    request,
    response,
    turnViews: views,
    projectId: 'project_1',
    turnId: 'turn_1',
  });

  assert.match(
    chunks.join(''),
    /event: error\ndata: \{"code":"TURN_NOT_FOUND","message":"turn exploded"\}/,
  );
});

test('SSE hides unknown errors behind a stable internal code', async () => {
  const chunks = [];
  const response = {
    writeHead() {},
    write(chunk) {
      chunks.push(chunk);
      return true;
    },
    end() {},
  };
  const request = { on() {} };
  const views = {
    async turnChangedSince() {
      throw new Error('database password is wrong');
    },
  };

  await handleTurnEvents({
    request,
    response,
    turnViews: views,
    projectId: 'project_1',
    turnId: 'turn_1',
  });

  assert.match(
    chunks.join(''),
    /event: error\ndata: \{"code":"INTERNAL_ERROR","message":"Turn event stream failed"\}/,
  );
  assert.ok(!chunks.join('').includes('database password'));
});

test('SSE emits an error event when polling rejects mid-stream', async () => {
  const chunks = [];
  const response = {
    writeHead() {},
    write(chunk) {
      chunks.push(chunk);
      return true;
    },
    end() {},
  };
  const request = { on() {} };
  let calls = 0;
  const server = http.createServer((req, res) =>
    handleTurnEvents({
      request: req,
      response: res,
      turnViews: {
        async turnChangedSince() {
          calls += 1;
          if (calls === 1) return { changed: true, fingerprint: 'f1' };
          throw new Error('database went away');
        },
        async loadTurnDetail() {
          return { status: 'running', generations: [] };
        },
      },
      projectId: 'project_1',
      turnId: 'turn_1',
      pollMs: '40',
    }));
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const streamResponse = await fetch(`http://127.0.0.1:${server.address().port}/projects/p1/turns/t1/events`);
    const reader = streamResponse.body.getReader();
    let text = '';
    while (!text.includes('event: error')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += Buffer.from(value).toString();
    }
    assert.match(text, /event: turn\ndata:/);
    assert.match(
      text,
      /event: error\ndata: \{"code":"INTERNAL_ERROR","message":"Turn event stream failed"\}/,
    );
  } finally {
    server.close();
  }
});

test('SSE pushes only the initial snapshot while the fingerprint is unchanged', async () => {
  const detail = () => ({ turnId: 't1', status: 'running', generations: [] });
  let calls = 0;
  const views = {
    loadTurnDetail: async () => {
      calls += 1;
      return detail();
    },
    turnChangedSince: async () => ({ changed: calls === 0, fingerprint: `f${calls}` }),
  };
  const server = http.createServer((req, res) =>
    handleTurnEvents({ request: req, response: res, turnViews: views, projectId: 'p1', turnId: 't1', pollMs: '40' }));
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/projects/p1/turns/t1/events`);
    const reader = response.body.getReader();
    const deadline = Date.now() + 400;
    let events = '';
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      events += Buffer.from(value).toString();
    }
    const turnEvents = (events.match(/event: turn/g) ?? []).length;
    assert.equal(turnEvents, 1, `expected only the initial snapshot, got ${turnEvents}`);
    assert.ok(events.includes('event: done') === false, 'non-terminal turn must not emit done');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

after(() => new Promise((resolve) => setImmediate(resolve)));

test('CORS preflight allows the frontend custom header and origin', async () => {
  const server = createApiServer({ repository: {}, queue: fakeQueue(), turnViews: fakeViews({}) });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  try {
    const preflight = await fetch(`http://127.0.0.1:${port}/projects/x/messages`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'idempotency-key, content-type',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
    assert.match(preflight.headers.get('access-control-allow-headers'), /idempotency-key/i);

    const health = await fetch(`http://127.0.0.1:${port}/health`, { headers: { origin: 'http://localhost:5173' } });
    assert.equal(health.headers.get('access-control-allow-origin'), '*');
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
