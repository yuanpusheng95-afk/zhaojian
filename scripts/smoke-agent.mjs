#!/usr/bin/env node
// 真实 Agent 冒烟。会产生 LLM 与图像供应商费用，不进 CI。
import { randomUUID } from 'node:crypto';
import pg from 'pg';

import { loadWorkerConfig } from '../src/config.mjs';
import { runMigrations } from '../src/infrastructure/postgres/migrate.mjs';
import { createAgentTurnQueue } from '../src/infrastructure/postgres/agent-turn-queue.mjs';
import { PostgresPhotoProjectRepository } from '../src/infrastructure/postgres/photo-project-repository.mjs';

const config = loadWorkerConfig(process.env);
const pool = new pg.Pool({ connectionString: config.databaseUrl });
await runMigrations(pool);
const repository = new PostgresPhotoProjectRepository({ pool });
const queue = createAgentTurnQueue({ pool, leaseMs: config.turnLeaseMs });

const projectId = process.argv[2];
if (!projectId) {
  process.stderr.write('Usage: npm run smoke:agent -- <projectId> [message...]\n');
  process.exit(1);
}
const userMessage = process.argv.slice(3).join(' ') || '把背景换成海边沙滩，保持人物面部特征不变';
const idempotencyKey = `smoke_${randomUUID()}`;

const project = await repository.getProject(projectId);
const turn = await queue.requestTurn({ projectId, userMessage, idempotencyKey });
process.stderr.write(`project: ${projectId}\nturn: ${turn.turnId}\nactiveRevision: ${project.activeRevisionId}\n`);
process.stderr.write(`Start worker with: npm run start:worker\n`);

const deadline = Date.now() + config.guards.turnTimeoutMs + 10_000;
while (Date.now() < deadline) {
  const result = await pool.query('SELECT status, outcome_json, error_json FROM agent_turns WHERE id = $1', [turn.turnId]);
  const row = result.rows[0];
  if (row && ['completed', 'failed', 'aborted'].includes(row.status)) {
    process.stderr.write(JSON.stringify(row, null, 2));
    process.stdout.write(`${JSON.stringify({ name: 'agent.smoke.turn', turnId: turn.turnId, projectId, status: row.status })}\n`);
    await pool.end();
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
process.stderr.write('Timed out waiting for the worker.\n');
await pool.end();
process.exit(1);
