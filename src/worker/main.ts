import pg from "pg";
import Redis from "ioredis";

import { runAgentTurn } from "../agent/agent-runner.js";
import { createReadPhotoStateTool } from "../agent/tools/read-photo-state.js";
import { createGenerateImageTool } from "../agent/tools/generate-image.js";
import { createSelectCandidateTool } from "../agent/tools/select-candidate.js";
import { createTurnContext } from "../agent/tools/turn-context.js";
import { loadWorkerConfig } from "../config.js";
import { createAgentTurnQueue } from "../infrastructure/postgres/agent-turn-queue.js";
import { PostgresPhotoProjectRepository } from "../infrastructure/postgres/photo-project-repository.js";
import { createLlmModels } from "../infrastructure/models/llm-provider.js";
import { createRelayImagesModels } from "../infrastructure/models/relay-images-provider.js";
import { createS3AssetStorage } from "../infrastructure/storage/s3-asset-storage.js";
import { createPostgresSessionRepo } from "../infrastructure/postgres/session/repo.js";
import { createStdoutTelemetry, createNoopTelemetry } from "../infrastructure/telemetry/stdout-telemetry.js";
import { createPgTelemetry, createTeeTelemetry } from "../infrastructure/telemetry/pg-telemetry.js";
import { instrumentStreamFn } from "../infrastructure/telemetry/stream-fn.js";
import { AgentTurnWorker } from "./agent-turn-worker.js";
import { createTurnEventPublisher } from "../infrastructure/redis/turn-events.js";

const config = loadWorkerConfig(process.env);
const pool = new pg.Pool({ connectionString: config.databaseUrl });
const stdoutTelemetry = config.telemetry === "stdout" ? createStdoutTelemetry() : createNoopTelemetry();
const pgTelemetry = createPgTelemetry({ pool });
const telemetry = createTeeTelemetry([stdoutTelemetry as any, pgTelemetry as any]);

const repository = new PostgresPhotoProjectRepository({ pool });
const sessionRepo = createPostgresSessionRepo({ pool });
const redis = new Redis(config.redisUrl);
const queue = createAgentTurnQueue({
  pool,
  leaseMs: config.turnLeaseMs,
  eventPublisher: createTurnEventPublisher(redis),
});
const llmModels = createLlmModels(config.llm);
const imagesModels = createRelayImagesModels({
  baseUrl: config.image.baseUrl,
  modelId: config.image.modelId,
});
const imageModel = imagesModels.getModel("relay", config.image.modelId);
Object.assign(imagesModels, { model: imageModel });
const llmModel = llmModels.getModel("deepseek", config.llm.modelId);
if (!llmModel) throw new Error(`LLM model is not registered: ${config.llm.modelId}`);
const assetStorage = createS3AssetStorage(config.s3);
const rawStreamFn = llmModels.streamSimple.bind(llmModels);

async function executeTurn(turn: any) {
  const project = await repository.getProject(turn.projectId);
  const revision = await repository.getRevision(project.activeRevisionId as string);
  const turnContext = createTurnContext({
    projectId: turn.projectId,
    turnId: turn.turnId,
    initialBaseAssetId: (revision.anchorAssetId ?? null) as string | null,
    activeRevisionId: revision.id,
  });
  const streamFn = instrumentStreamFn({
    telemetry,
    streamFn: rawStreamFn as unknown as (...args: any[]) => Promise<any>,
    attributes: { "pi.turn.id": turn.turnId, "pi.project.id": turn.projectId },
  });
  const tools = [
    createReadPhotoStateTool({ repository, turnContext }),
    createGenerateImageTool({ repository, imagesModels, assetStorage, turnContext, config, telemetry }),
    createSelectCandidateTool({ repository, turnContext }),
  ];
  const result = await runAgentTurn({ sessionRepo, config, model: llmModel, turn, tools, streamFn, telemetry });
  const generations = await repository.listGenerationsByTurn({ projectId: turn.projectId, turnId: turn.turnId });
  return {
    ...result,
    outcome: {
      toolCalls: result.stats?.toolCalls ?? 0,
      toolErrors: result.stats?.toolErrors ?? 0,
      generations: generations.length,
      selected: generations.some((generation: any) => generation.selectedRevisionId != null),
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
