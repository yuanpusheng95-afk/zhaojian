import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';

import pg from 'pg';

import { createAgentTurnQueue } from '../src/infrastructure/postgres/agent-turn-queue.mjs';
import { runMigrations } from '../src/infrastructure/postgres/migrate.mjs';
import { PostgresPhotoProjectRepository } from '../src/infrastructure/postgres/photo-project-repository.mjs';
import { createS3AssetStorage } from '../src/infrastructure/storage/s3-asset-storage.mjs';
import { buildAssetKey, buildAssetUri } from '../src/infrastructure/storage/asset-storage.mjs';
import { loadApiConfig } from '../src/config.mjs';
import { createTurnViews } from '../src/api/turn-views.mjs';
import { createApiServer } from '../src/api/server.mjs';

const config = loadApiConfig({
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ??
    'postgres://photo_agent:photo_agent@127.0.0.1:54329/photo_agent_test',
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9000',
  S3_BUCKET: process.env.S3_BUCKET ?? 'photo-agent',
  S3_ACCESS_KEY: process.env.S3_ACCESS_KEY ?? 'photoagent',
  S3_SECRET_KEY: process.env.S3_SECRET_KEY ?? 'photoagent123',
  S3_REGION: process.env.S3_REGION ?? 'us-east-1',
});
const pool = new pg.Pool({ connectionString: config.databaseUrl });
const queue = createAgentTurnQueue({ pool });
const repository = new PostgresPhotoProjectRepository({ pool });
const assetStorage = createS3AssetStorage(config.s3);
const turnViews = createTurnViews({
  pool,
  repository,
  assetStorage,
  signedUrlTtlSeconds: 60,
});

let server;
let baseUrl;

beforeEach(async () => {
  const database = await pool.query('SELECT current_database() AS name');
  if (!database.rows[0].name.endsWith('_test')) {
    throw new Error(`Refusing to reset non-test database: ${database.rows[0].name}`);
  }
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations(pool);

  server?.close();
  server = createApiServer({ repository, queue, turnViews, assetStorage, logger: console });
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server?.close(resolve));
  await pool.end();
});

function initialState() {
  return {
    subject: {
      personId: 'person_1',
      identity: { preserve: true },
    },
    scene: { location: 'studio' },
    appearance: { outfit: 'black jacket' },
    composition: { shot: 'medium' },
    constraints: [],
  };
}

async function createProjectFixture() {
  const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>');
  const project = await repository.createProject({
    projectId: 'project_fixture',
    name: 'API smoke',
    initialState: initialState(),
    anchorAsset: {
      assetId: 'asset_anchor_1',
      uri: buildAssetUri(
        config.s3.bucket,
        buildAssetKey({
          ownerId: 'dev',
          projectId: 'project_fixture',
          assetId: 'asset_anchor_1',
          contentType: 'image/png',
        }),
      ),
      metadata: { source: 'test', contentType: 'image/png' },
    },
  });
  await assetStorage.put(
    buildAssetKey({
      ownerId: 'dev',
      projectId: 'project_fixture',
      assetId: 'asset_anchor_1',
      contentType: 'image/png',
    }),
    bytes,
    'image/png',
  );

  await assetStorage.put(
    buildAssetKey({
      ownerId: 'dev',
      projectId: 'project_fixture',
      assetId: 'asset_candidate_1',
      contentType: 'image/png',
    }),
    bytes,
    'image/png',
  );
  return project;
}

function editPatch() {
  return {
    modify: [{ path: 'appearance.outfit', operation: 'replace', value: 'ivory coat' }],
    preserve: [
      { path: 'subject.identity', strength: 'hard' },
      { path: 'scene.background', strength: 'hard' },
    ],
  };
}

async function createCompletedGeneration(projectId, turnId) {
  const project = await repository.getProject(projectId);
  const outcome = {
    kind: 'completed',
    candidate: {
      candidateId: 'candidate_1',
      assetId: 'asset_candidate_1',
      uri: buildAssetUri(
        config.s3.bucket,
        buildAssetKey({
          ownerId: 'dev',
          projectId,
          assetId: 'asset_candidate_1',
          contentType: 'image/png',
        }),
      ),
      metadata: { model: 'integration', contentType: 'image/png' },
      verification: { passed: true },
    },
  };
  await repository.recordGeneration({
    projectId,
    turnId,
    baseRevisionId: project.activeRevisionId,
    inputAssetId: 'asset_anchor_1',
    patch: editPatch(),
    renderPrompt: 'ivory coat',
    outcome,
  });
}

test('HTTP API covers idempotent turns, signed candidates, selection, and SSE', async () => {
  await createProjectFixture();

  const created = await fetch(`${baseUrl}/projects/project_fixture/messages`, {
    method: 'POST',
    headers: { 'idempotency-key': 'http-key' },
    body: JSON.stringify({ message: 'make the coat ivory' }),
  });
  assert.equal(created.status, 202);
  const createdBody = await created.json();
  assert.equal(createdBody.replayed, false);

  const replayed = await fetch(`${baseUrl}/projects/project_fixture/messages`, {
    method: 'POST',
    headers: { 'idempotency-key': 'http-key' },
    body: JSON.stringify({ message: 'make the coat ivory' }),
  });
  assert.equal(replayed.status, 200);
  assert.deepEqual(await replayed.json(), { ...createdBody, replayed: true });

  const conflict = await fetch(`${baseUrl}/projects/project_fixture/messages`, {
    method: 'POST',
    headers: { 'idempotency-key': 'http-key' },
    body: JSON.stringify({ message: 'different message' }),
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'IDEMPOTENCY_CONFLICT');

  await createCompletedGeneration('project_fixture', createdBody.turnId);
  const detailResponse = await fetch(`${baseUrl}/projects/project_fixture/turns/${createdBody.turnId}`);
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  const candidate = detail.generations[0].candidate;
  assert.equal(candidate.contentType, 'image/png');

  const image = await fetch(candidate.url);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.ok((await image.arrayBuffer()).byteLength > 0);

  const eventsUrl = `${baseUrl}/projects/project_fixture/turns/${createdBody.turnId}/events?pollMs=250`;
  const controller = new AbortController();
  const eventPromise = (async () => {
    const events = await fetch(eventsUrl, { signal: controller.signal });
    assert.equal(events.headers.get('content-type'), 'text/event-stream');
    const reader = events.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('event: done')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text;
  })();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await pool.query(
    `UPDATE agent_turns SET status = 'completed', updated_at = now()
     WHERE id = $1`,
    [createdBody.turnId],
  );
  const eventsText = await eventPromise;
  controller.abort();
  assert.match(eventsText, /event: turn\ndata: /);
  assert.match(eventsText, /"status":"completed"/);
  assert.match(eventsText, /event: done\n/);

  const selected = await fetch(
    `${baseUrl}/projects/project_fixture/turns/${createdBody.turnId}/selections`,
    {
      method: 'POST',
      body: JSON.stringify({ generationId: detail.generations[0].generationId, candidateId: 'candidate_1' }),
    },
  );
  assert.equal(selected.status, 200);
  const selectedBody = await selected.json();
  assert.ok(selectedBody.revisionId.startsWith('revision_'));

  const repeated = await fetch(
    `${baseUrl}/projects/project_fixture/turns/${createdBody.turnId}/selections`,
    {
      method: 'POST',
      body: JSON.stringify({ generationId: detail.generations[0].generationId, candidateId: 'candidate_1' }),
    },
  );
  assert.equal(repeated.status, 200);
  assert.deepEqual(await repeated.json(), selectedBody);

  const project = await repository.getProject('project_fixture');
  assert.equal(project.activeRevisionId, selectedBody.revisionId);
});
