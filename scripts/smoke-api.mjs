#!/usr/bin/env node
// 真实端到端冒烟。会产生 LLM 与图像供应商费用，不进 CI。

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import pg from 'pg';

import { loadApiConfig, loadWorkerConfig } from '../src/config.js';
import { runMigrations } from '../src/infrastructure/postgres/migrate.js';
import { createAgentTurnQueue } from '../src/infrastructure/postgres/agent-turn-queue.js';
import { PostgresPhotoProjectRepository } from '../src/infrastructure/postgres/photo-project-repository.js';
import { createS3AssetStorage } from '../src/infrastructure/storage/s3-asset-storage.js';
import { buildAssetKey, buildAssetUri } from '../src/infrastructure/storage/asset-storage.js';
import { createTurnViews } from '../src/api/turn-views.js';
import { createApiServer } from '../src/api/server.js';

function emit(name, data = {}) {
  process.stdout.write(`${JSON.stringify({ name, ...data })}\n`);
}

const projectId = process.argv[2] ?? 'smoke_api_1';
const userMessage = process.argv.slice(3).join(' ') || '把背景换成海边沙滩，保持人物面部特征不变';
const apiConfig = loadApiConfig(process.env);
const workerConfig = loadWorkerConfig(process.env);

const pool = new pg.Pool({ connectionString: apiConfig.databaseUrl });
await runMigrations(pool);
const repository = new PostgresPhotoProjectRepository({ pool });
const queue = createAgentTurnQueue({ pool, leaseMs: workerConfig.turnLeaseMs });
const assetStorage = createS3AssetStorage(apiConfig.s3);
const turnViews = createTurnViews({
  pool,
  repository,
  assetStorage,
  signedUrlTtlSeconds: apiConfig.signedUrlTtlSeconds,
});
const server = createApiServer({ repository, queue, turnViews });
await new Promise((resolve) => server.listen(apiConfig.port, resolve));
const baseUrl = `http://127.0.0.1:${apiConfig.port}`;

try {
  await repository.getProject(projectId);
} catch {
  throw new Error(`Project not found: ${projectId}. Run npm run seed:smoke first.`);
}

const worker = spawn(process.execPath, ['src/worker/main.mjs'], {
  env: process.env,
  stdio: ['ignore', 'ignore', 'inherit'],
});
emit('worker.started', { pid: worker.pid });

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const body = response.headers.get('content-type')?.includes('application/json')
    ? await response.json()
    : null;
  return { status: response.status, body };
}

try {
  const created = await request(`/projects/${projectId}/messages`, {
    method: 'POST',
    headers: { 'idempotency-key': `smoke_${randomUUID()}` },
    body: JSON.stringify({ message: userMessage }),
  });
  if (created.status !== 202) {
    throw new Error(`POST messages failed: ${created.status} ${JSON.stringify(created.body)}`);
  }
  emit('turn.created', created.body);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), workerConfig.guards.turnTimeoutMs + 10_000);
  let detail;
  try {
    const events = await fetch(
      `${baseUrl}/projects/${projectId}/turns/${created.body.turnId}/events?pollMs=500`,
      { signal: controller.signal },
    );
    if (!events.ok) throw new Error(`GET events failed: ${events.status}`);
    const reader = events.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('event: done')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    const turnLine = text.split('\n\n').find((chunk) => chunk.includes('"status":"completed"'));
    if (!turnLine) throw new Error(`Turn did not complete successfully: ${text}`);
    detail = JSON.parse(turnLine.replace(/^event: turn\ndata: /, ''));
    emit('turn.completed', { turnId: detail.turnId, generations: detail.generations.length });
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }

  const generation = detail.generations.find((item) => item.candidate?.url && !item.selectedRevisionId);
  if (!generation) throw new Error('No selectable signed candidate returned');
  const image = await fetch(generation.candidate.url);
  if (image.status !== 200 || !(await image.arrayBuffer()).byteLength) {
    throw new Error('Signed image could not be fetched');
  }
  emit('image.fetched', { assetId: generation.candidate.assetId });

  const selected = await request(
    `/projects/${projectId}/turns/${detail.turnId}/selections`,
    {
      method: 'POST',
      body: JSON.stringify({
        generationId: generation.generationId,
        candidateId: generation.candidate.id,
      }),
    },
  );
  if (selected.status !== 200) {
    throw new Error(`Selection failed: ${selected.status} ${JSON.stringify(selected.body)}`);
  }
  const updatedProject = await repository.getProject(projectId);
  if (updatedProject.activeRevisionId !== selected.body.revisionId) {
    throw new Error('Active revision was not switched');
  }
  emit('selection.completed', selected.body);
} finally {
  worker.kill('SIGTERM');
  const exited = await new Promise((resolve) => {
    worker.once('exit', () => resolve({ exited: true }));
    setTimeout(() => resolve({ exited: false }), 2_000).unref();
  });
  if (!exited) {
    worker.kill('SIGKILL');
    emit('worker.killed', { pid: worker.pid });
  }
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
}
