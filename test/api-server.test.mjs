import assert from 'node:assert/strict';
import { describe, expect, test } from 'bun:test';


import { IdempotencyConflictError, ProjectBusyError } from '../src/infrastructure/postgres/agent-turn-queue.js';
import { createTurnEventStream, parsePollMs, toErrorPayload } from '../src/api/sse.js';
import { createApiServer } from '../src/api/server.js';
import { createApp } from '../src/api/app.js';

function startServer(dependencies) {
  const server = createApiServer({
    assetStorage: { bucket: 'photo-agent', async put() {} },
    ...dependencies,
  });
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
    async getProject(projectId) {
      return { id: projectId, ownerId: 'dev' };
    },
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
  const controller = new AbortController();
  const events = [];
  for await (const event of createTurnEventStream({
    turnViews: fakeViews({ status: 'completed', generations: [] }),
    projectId: 'project_1',
    turnId: 'turn_1',
    pollMs: 250,
    signal: controller.signal,
  })) {
    events.push(event);
  }
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'snapshot');
  assert.equal(events[1].type, 'done');
});

test('SSE emits an error event when views reject', async () => {
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
  const controller = new AbortController();
  const events = [];
  for await (const event of createTurnEventStream({
    turnViews: views,
    projectId: 'project_1',
    turnId: 'turn_1',
    pollMs: 250,
    signal: controller.signal,
  })) {
    events.push(event);
  }
  assert.deepEqual(events, [{ type: 'error', payload: { code: 'TURN_NOT_FOUND', message: 'turn exploded' } }]);
});

test('SSE hides unknown errors behind a stable internal code', async () => {
  const views = {
    async turnChangedSince() {
      throw new Error('database password is wrong');
    },
  };
  const controller = new AbortController();
  const events = [];
  for await (const event of createTurnEventStream({
    turnViews: views,
    projectId: 'project_1',
    turnId: 'turn_1',
    pollMs: 250,
    signal: controller.signal,
  })) {
    events.push(event);
  }
  assert.deepEqual(events, [{ type: 'error', payload: { code: 'INTERNAL_ERROR', message: 'Turn event stream failed' } }]);
});

test('SSE emits an error event when polling rejects mid-stream', async () => {
  let calls = 0;
  const controller = new AbortController();
  const events = [];
  for await (const event of createTurnEventStream({
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
    pollMs: 40,
    signal: controller.signal,
  })) {
    events.push(event);
    if (event.type === 'error') break;
  }
  assert.equal(events[0].type, 'snapshot');
  assert.deepEqual(events[1], { type: 'error', payload: { code: 'INTERNAL_ERROR', message: 'Turn event stream failed' } });
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
  const app = createApp({
    pool: {},
    queue: {},
    repository: { async getProject() { return { id: 'p1', ownerId: 'dev' }; } },
    assetStorage: { bucket: 'photo-agent' },
    turnViews: views,
  });
  const abortController = new AbortController();
  try {
    const response = await app.request('/projects/p1/turns/t1/events?pollMs=40', { signal: abortController.signal });
    const reader = response.body.getReader();
    let events = '';
    for (let index = 0; index < 3; index += 1) {
      const { value, done } = await reader.read();
      if (done) break;
      events += Buffer.from(value).toString();
      if (events.includes('event: turn')) break;
    }
    const turnEvents = (events.match(/event: turn/g) ?? []).length;
    assert.equal(turnEvents, 1, `expected only the initial snapshot, got ${turnEvents}`);
    assert.ok(events.includes('event: done') === false, 'non-terminal turn must not emit done');
  } finally {
    abortController.abort();
  }
});


test('CORS preflight allows the frontend custom header and origin', async () => {
  const server = createApiServer({ repository: { async getProject() { return { id: 'p1', ownerId: 'dev' }; } }, queue: fakeQueue(), turnViews: fakeViews({}), assetStorage: { bucket: 'photo-agent', async put() {} } });
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

test('uploads stores bytes and returns the anchor descriptor', async () => {
  const puts = [];
  const fakeRepository = { ...{}, async recordAsset({ assetId, uri, metadata }) { return { id: assetId, uri, metadata }; } };
  const fakeStorage = {
    bucket: 'photo-agent',
    async put(key, bytes, contentType) { puts.push({ key, bytes, contentType }); },
  };
  const { server, url } = await startServer({
    repository: fakeRepository,
    queue: fakeQueue(),
    turnViews: fakeViews({}),
    assetStorage: fakeStorage,
  });
  try {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const response = await fetch(`${url}/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: png,
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.match(body.assetId, /^upload_/);
    assert.match(body.uri, /^s3:\/\/photo-agent\/users\/dev\/projects\/uploads\/upload_[^.]+\.png$/);
    assert.equal(body.metadata.contentType, 'image/png');
    assert.deepEqual(puts[0].bytes, png);

    const parameterized = await fetch(`${url}/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'image/png; boundary=example' },
      body: png,
    });
    assert.equal(parameterized.status, 201);

    const rejected = await fetch(`${url}/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(rejected.status, 415);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('SSE falls back to polling after a Redis stream error', async () => {
  let loadCalls = 0;
  let readCalls = 0;
  const app = createApp({
    pool: {},
    queue: {},
    repository: { async getProject() { return { id: 'p1', ownerId: 'dev' }; } },
    assetStorage: { bucket: 'photo-agent' },
    eventConsumer: {
      async readTurnEvent() {
        readCalls += 1;
        throw new Error('redis went away');
      },
    },
    turnViews: {
      loadTurnDetail: async () => {
        loadCalls += 1;
        return { turnId: 't1', status: loadCalls === 1 ? 'running' : 'completed', generations: [] };
      },
      turnChangedSince: async () => ({ changed: true, fingerprint: `f${loadCalls}` }),
    },
  });

  const response = await app.request('/projects/p1/turns/t1/events?pollMs=250');
  const events = await new Response(response.body).text();
  assert.equal(readCalls, 1);
  assert.match(events, /event: turn\ndata:/);
  assert.match(events, /event: done\ndata: \{\}/);
});

test('uploads and project creation honor the x-user-id header', async () => {
  const puts = [];
  const createdProjects = [];
  const { server, url } = await startServer({
    repository: {
      async recordAsset({ assetId, uri, metadata }) {
        return { id: assetId, uri, metadata };
      },
      async createProject(body) {
        createdProjects.push(body);
        return { id: 'project_1', ...body };
      },
    },
    queue: fakeQueue(),
    turnViews: fakeViews({}),
    assetStorage: {
      bucket: 'photo-agent',
      async put(key, bytes, contentType) {
        puts.push({ key, bytes, contentType });
      },
    },
  });

  try {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const upload = await fetch(`${url}/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', 'x-user-id': 'alice' },
      body: png,
    });
    assert.equal(upload.status, 201);
    const uploadBody = await upload.json();
    assert.match(uploadBody.uri, /^s3:\/\/photo-agent\/users\/alice\/projects\/uploads\/upload_[^.]+\.png$/);
    assert.match(puts[0].key, /^users\/alice\/projects\/uploads\//);

    const project = await fetch(`${url}/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'alice' },
      body: JSON.stringify({ name: 'Portrait' }),
    });
    assert.equal(project.status, 201);
    assert.equal(createdProjects.at(-1).ownerId, 'alice');
    assert.deepEqual(createdProjects.at(-1).initialState, {});

    const rejected = await fetch(`${url}/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', 'x-user-id': '../evil' },
      body: png,
    });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).error.code, 'INVALID_USER_ID');
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('access policy can deny reads and writes with 404', async () => {
  const { HttpError } = await import('../src/api/http-error.js');
  const app = createApp({
    repository: fakeRepository(),
    queue: fakeQueue(),
    turnViews: fakeViews({ status: 'completed' }),
    assetStorage: { bucket: 'photo-agent', async put() {} },
    accessPolicy: {
      assertAccess({ userId, resource, action }) {
        if (resource.ownerId !== userId) {
          throw new HttpError(404, 'PROJECT_NOT_FOUND', `Project not accessible to ${userId}`);
        }
      },
    },
  });
  const server = createApiServer({
    repository: fakeRepository(),
    queue: fakeQueue(),
    turnViews: fakeViews({ status: 'completed' }),
    assetStorage: { bucket: 'photo-agent', async put() {} },
    accessPolicy: {
      assertAccess({ userId, resource }) {
        if (resource.ownerId !== userId) {
          throw new HttpError(404, 'PROJECT_NOT_FOUND', `Project not accessible to ${userId}`);
        }
      },
    },
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  try {
    // owner can read
    const own = await fetch(`${url}/projects/p1`, { headers: { 'x-user-id': 'dev' } });
    assert.equal(own.status, 200);

    // non-owner gets 404 on read
    const foreign = await fetch(`${url}/projects/p1`, { headers: { 'x-user-id': 'mallory' } });
    assert.equal(foreign.status, 404);
    assert.equal((await foreign.json()).error.code, 'PROJECT_NOT_FOUND');

    // non-owner gets 404 on write
    const write = await fetch(`${url}/projects/p1/messages`, {
      method: 'POST',
      headers: { 'x-user-id': 'mallory', 'idempotency-key': 'k1' },
      body: JSON.stringify({ message: 'hi' }),
    });
    assert.equal(write.status, 404);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('auth mode: unauthenticated requests get 401 and authenticated ones pass ownership checks', async () => {
  const { createJwtSessionStore } = await import('../src/infrastructure/auth/jwt-session.js');
  const { HttpError } = await import('../src/api/http-error.js');

  // 最小 Redis 替身
  const store = new Map();
  const redis = {
    async set(key, value) { store.set(key, value); },
    async get(key) { return store.get(key) ?? null; },
    async del(key) { store.delete(key); },
  };
  const sessionStore = createJwtSessionStore({
    jwtSecret: 'api-test-secret-0123456789abcdef',
    redis,
    ttlSeconds: 3600,
  });

  const server = createApiServer({
    repository: fakeRepository(),
    queue: fakeQueue(),
    turnViews: fakeViews({}),
    assetStorage: { bucket: 'photo-agent', async put() {} },
    sessionStore,
    authPool: {}, // auth routes not exercised in this test
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  try {
    // 未登录 → 401（不再是回落 dev）
    const anon = await fetch(`${url}/projects/p1`);
    assert.equal(anon.status, 401);

    // 登录 user_dev（fakeRepository 里 p1 的 ownerId 是 dev）→ 200
    const session = await sessionStore.issue('dev');
    const authed = await fetch(`${url}/projects/p1`, {
      headers: { cookie: `auth_token=${session.token}` },
    });
    assert.equal(authed.status, 200);

    // 登录了别人 → 404 掩盖存在性
    const otherSession = await sessionStore.issue('mallory');
    const foreign = await fetch(`${url}/projects/p1`, {
      headers: { cookie: `auth_token=${otherSession.token}` },
    });
    assert.equal(foreign.status, 404);

    // 无效 token → 401
    const bad = await fetch(`${url}/projects/p1`, {
      headers: { cookie: 'auth_token=garbage.token.value' },
    });
    assert.equal(bad.status, 401);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('api key auth: Bearer zj_ token grants the owner access without a cookie', async () => {
  const { createJwtSessionStore } = await import('../src/infrastructure/auth/jwt-session.js');
  const { createApiKeyStore } = await import('../src/infrastructure/auth/api-keys.js');

  const sessionMap = new Map();
  const redis = {
    async set(k, v) { sessionMap.set(k, v); },
    async get(k) { return sessionMap.get(k) ?? null; },
    async del(k) { sessionMap.delete(k); },
  };
  const sessionStore = createJwtSessionStore({
    jwtSecret: 'api-test-secret-0123456789abcdef',
    redis,
    ttlSeconds: 3600,
  });

  // 内存 api_keys 表
  const keyRows = new Map();
  const authPool = {
    async query(sql, params) {
      if (sql.includes('INSERT INTO api_keys')) {
        const row = { id: params[0], userId: params[1], keyHash: params[2], name: params[3], lastUsedAt: null, revokedAt: null, createdAt: new Date() };
        keyRows.set(row.id, row);
        keyRows.byHash ??= new Map();
        return { rows: [{ id: row.id, userId: row.userId, name: row.name, createdAt: row.createdAt }], rowCount: 1 };
      }
      if (sql.includes('SET last_used_at')) {
        const found = [...keyRows.values()].find((r) => r?.keyHash === params[0] && !r.revokedAt);
        if (!found) return { rows: [], rowCount: 0 };
        return { rows: [{ user_id: found.userId }], rowCount: 1 };
      }
      if (sql.includes('SET revoked_at')) {
        const row = keyRows.get(params[0]);
        if (!row || row.userId !== params[1] || row.revokedAt) return { rowCount: 0 };
        row.revokedAt = new Date();
        return { rowCount: 1 };
      }
      if (sql.includes('ORDER BY created_at')) {
        return { rows: [...keyRows.values()].filter((r) => r.userId === params[0]) };
      }
      throw new Error('unexpected sql');
    },
  };

  const server = createApiServer({
    repository: fakeRepository(),
    queue: fakeQueue(),
    turnViews: fakeViews({}),
    assetStorage: { bucket: 'photo-agent', async put() {} },
    sessionStore,
    authPool,
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  try {
    // 先用会话登录创建一个 key
    const login = await sessionStore.issue('dev');
    const createRes = await fetch(`${url}/auth/keys`, {
      method: 'POST',
      headers: { cookie: `auth_token=${login.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'cli' }),
    });
    assert.equal(createRes.status, 201);
    const { key, id: keyId } = await createRes.json();
    assert.match(key, /^zj_/);

    // Bearer key 访问业务接口 → 200（p1 属于 dev）
    const viaKey = await fetch(`${url}/projects/p1`, {
      headers: { authorization: `Bearer ${key}` },
    });
    assert.equal(viaKey.status, 200);

    // 无效 key → 401
    const bad = await fetch(`${url}/projects/p1`, {
      headers: { authorization: `Bearer zj_invalidinvalidinvalidinvalidinvalid12` },
    });
    assert.equal(bad.status, 401);

    // 吊销后立即失效
    const revokeRes = await fetch(`${url}/auth/keys/${keyId}`, {
      method: 'DELETE',
      headers: { cookie: `auth_token=${login.token}` },
    });
    assert.equal(revokeRes.status, 200);
    const afterRevoke = await fetch(`${url}/projects/p1`, {
      headers: { authorization: `Bearer ${key}` },
    });
    assert.equal(afterRevoke.status, 401);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
