import pg from 'pg';

import { runAgentTurn } from '../agent/agent-runner.mjs';
import { createReadPhotoStateTool } from '../agent/tools/read-photo-state.mjs';
import { createGenerateImageTool } from '../agent/tools/generate-image.mjs';
import { createSelectCandidateTool } from '../agent/tools/select-candidate.mjs';
import { createTurnContext } from '../agent/tools/turn-context.mjs';
import { loadWorkerConfig } from '../config.mjs';
import { createAgentTurnQueue } from '../infrastructure/postgres/agent-turn-queue.mjs';
import { runMigrations } from '../infrastructure/postgres/migrate.mjs';
import { createPostgresSessionRepo } from '../infrastructure/postgres/session/repo.mjs';
import { PostgresPhotoProjectRepository } from '../infrastructure/postgres/photo-project-repository.mjs';
import { createLlmModels } from '../infrastructure/models/llm-provider.mjs';
import { createRelayImagesModels } from '../infrastructure/models/relay-images-provider.mjs';
import { createS3AssetStorage } from '../infrastructure/storage/s3-asset-storage.mjs';
import { createNoopTelemetry, createStdoutTelemetry } from '../infrastructure/telemetry/stdout-telemetry.mjs';
import { createPgTelemetry, createTeeTelemetry } from '../infrastructure/telemetry/pg-telemetry.mjs';
import { instrumentStreamFn } from '../infrastructure/telemetry/stream-fn.mjs';
import { AgentTurnWorker } from './agent-turn-worker.mjs';

const { Pool } = pg;
const config = loadWorkerConfig(process.env);
const pool = new Pool({ connectionString: config.databaseUrl });
await runMigrations(pool);
// 双写:stdout 管实时观察(TELEMETRY=noop 可静音该腿),PG 管历史留存与聚合。
// PG 腿不可关——"哪一层失败、耗时多少"只在 span 里,不留存就不叫全程可观测
const stdoutTelemetry = config.telemetry === 'stdout' ? createStdoutTelemetry() : createNoopTelemetry();
const pgTelemetry = createPgTelemetry({ pool });
const telemetry = createTeeTelemetry([stdoutTelemetry, pgTelemetry]);

const repository = new PostgresPhotoProjectRepository({ pool });
const sessionRepo = createPostgresSessionRepo({ pool });
const queue = createAgentTurnQueue({ pool, leaseMs: config.turnLeaseMs });
const llmModels = createLlmModels(config.llm);
const imagesModels = createRelayImagesModels({
  baseUrl: config.image.baseUrl,
  modelId: config.image.modelId,
});
imagesModels.model = imagesModels.getModel('relay', config.image.modelId);
const llmModel = llmModels.getModel('deepseek', config.llm.modelId);
if (!llmModel) throw new Error(`LLM model is not registered: ${config.llm.modelId}`);
const assetStorage = createS3AssetStorage(config.s3);
const rawStreamFn = llmModels.streamSimple.bind(llmModels);

async function executeTurn(turn) {
  const project = await repository.getProject(turn.projectId);
  const revision = await repository.getRevision(project.activeRevisionId);
  const turnContext = createTurnContext({
    projectId: turn.projectId,
    turnId: turn.turnId,
    initialBaseAssetId: revision.anchorAssetId,
    activeRevisionId: revision.id,
  });
  // 每轮构建一次 instrumented streamFn,把 turn 属性烤进 pi.ai.request span——
  // PG 里按 turn_id 查就是一次索引命中,不再靠时间区间关联
  const streamFn = instrumentStreamFn({
    telemetry,
    streamFn: rawStreamFn,
    attributes: { 'pi.turn.id': turn.turnId, 'pi.project.id': turn.projectId },
  });
  const tools = [
    createReadPhotoStateTool({ repository, turnContext }),
    createGenerateImageTool({
      repository, imagesModels, assetStorage, turnContext, config, telemetry,
    }),
    createSelectCandidateTool({ repository, turnContext }),
  ];
  const result = await runAgentTurn({ sessionRepo, config, model: llmModel, turn, tools, streamFn, telemetry });
  const generations = await repository.listGenerationsByTurn({
    projectId: turn.projectId,
    turnId: turn.turnId,
  });
  return {
    ...result,
    outcome: {
      toolCalls: result.stats?.toolCalls ?? 0,
      toolErrors: result.stats?.toolErrors ?? 0,
      generations: generations.length,
      selected: generations.some((generation) => generation.selectedRevisionId != null),
    },
  };
}

const worker = new AgentTurnWorker({ queue, runTurn: executeTurn, config });
let shuttingDown = false;

async function poll() {
  while (!shuttingDown) {
    if (worker.inFlightCount >= config.workerConcurrency) {
      await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
      continue;
    }
    const claimed = await worker.runOnce();
    if (!claimed) {
      await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
    }
  }
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  worker.stop();
  process.stderr.write('[shutdown] signal received, waiting for in-flight turns\n');
  // race 的 grace 定时器必须显式清除:未被引用清除的 setTimeout 会把事件循环
  // 吊满 shutdownGraceMs(默认 10 分钟)——池关了进程也不退出(实测踩过)
  let graceTimer;
  const grace = new Promise((resolve) => {
    graceTimer = setTimeout(resolve, config.shutdownGraceMs);
  });
  try {
    await Promise.race([worker.waitUntilIdle(), grace]);
  } finally {
    clearTimeout(graceTimer);
  }
  process.stderr.write('[shutdown] idle, draining telemetry writes\n');
  // pool.end() 会拒绝仍在队列里的查询;先等在途 span 写入落定(上限 2s)再关池
  await pgTelemetry.drain(2_000);
  process.stderr.write('[shutdown] telemetry drained, closing pool\n');
  await pool.end();
  process.stderr.write('[shutdown] pool closed\n');
}

await poll();
