import pg from "pg";
import Redis from "ioredis";

import { runAgentTurn } from "../agent/agent-runner.js";
import { createAgentTools, createTurnContext } from "../agent/tools/index.js";
import { loadWorkerConfig } from "../config.js";
import { createAgentTurnQueue } from "../infrastructure/postgres/agent-turn-queue.js";
import { PostgresPhotoProjectRepository } from "../infrastructure/postgres/photo-project-repository.js";
import { createLlmModels } from "../infrastructure/models/llm-provider.js";
import { createRelayImageProvider } from "../infrastructure/models/relay-images-provider.js";
import { createS3AssetStorage } from "../infrastructure/storage/s3-asset-storage.js";
import { createPostgresSessionRepo } from "../infrastructure/postgres/session/repo.js";
import { createStdoutTelemetry, createNoopTelemetry } from "../infrastructure/telemetry/stdout-telemetry.js";
import { createPgTelemetry, createTeeTelemetry } from "../infrastructure/telemetry/pg-telemetry.js";
import { instrumentStreamFn } from "../infrastructure/telemetry/stream-fn.js";
import { AgentTurnWorker, type ClaimedTurn } from "./agent-turn-worker.js";
import { createTurnEventPublisher } from "../infrastructure/redis/turn-events.js";

const config = loadWorkerConfig(process.env);
const pool = new pg.Pool({ connectionString: config.databaseUrl });
const stdoutTelemetry = config.telemetry === "stdout" ? createStdoutTelemetry() : createNoopTelemetry();
const pgTelemetry = createPgTelemetry({ pool });
const telemetry = createTeeTelemetry([stdoutTelemetry, pgTelemetry]);

const repository = new PostgresPhotoProjectRepository({ pool });
const sessionRepo = createPostgresSessionRepo({ pool });
const redis = new Redis(config.redisUrl);
const queue = createAgentTurnQueue({
  pool,
  leaseMs: config.turnLeaseMs,
  eventPublisher: createTurnEventPublisher(redis),
});
function requireLlmModel(models: ReturnType<typeof createLlmModels>, modelId: string) {
  const model = models.getModel("deepseek", modelId);
  if (!model) throw new Error(`LLM model is not registered: ${modelId}`);
  return model;
}

const llmModels = createLlmModels(config.llm);
const llmModel = requireLlmModel(llmModels, config.llm.modelId);
const imageProvider = createRelayImageProvider({
  baseUrl: config.image.baseUrl,
  modelId: config.image.modelId,
  apiKey: config.image.apiKey,
  size: config.image.size,
  editRoute: config.image.editRoute,
});
const assetStorage = createS3AssetStorage(config.s3);
const rawStreamFn = llmModels.streamSimple.bind(llmModels);

async function executeTurn(turn: ClaimedTurn) {
  const project = await repository.getProject(turn.projectId);
  const revision = await repository.getRevision(project.activeRevisionId);
  const turnContext = createTurnContext({
    projectId: turn.projectId,
    ownerId: project.ownerId,
    turnId: turn.turnId,
    initialBaseAssetId: revision.anchorAssetId ?? null,
    activeRevisionId: revision.id,
  });
  const streamFn = instrumentStreamFn({
    telemetry,
    streamFn: rawStreamFn,
    attributes: { "pi.turn.id": turn.turnId, "pi.project.id": turn.projectId },
  });
  const tools = createAgentTools({ repository, imageProvider, assetStorage, turnContext, config, telemetry });
  const result = await runAgentTurn({ sessionRepo, config, model: llmModel, turn, tools, streamFn, telemetry });
  const generations = await repository.listGenerationsByTurn({ projectId: turn.projectId, turnId: turn.turnId });
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

let stopped = false;

async function main() {
  process.on("SIGINT", () => { stopped = true; worker.stop(); });
  process.on("SIGTERM", () => { stopped = true; worker.stop(); });

  while (!stopped) {
    try {
      const claimed = await worker.runOnce();
      if (claimed) await worker.waitUntilIdle();
      else await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs ?? 1000));
    } catch (error) {
      console.error("Agent turn failed:", error);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

await main();
