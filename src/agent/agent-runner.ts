import { Agent, buildSessionContext } from "@earendil-works/pi-agent-core";
import type { AgentEvent, Entry, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentState, AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import { createNoopTelemetry } from "@/infrastructure/telemetry/stdout-telemetry";
import type { TelemetryContext } from "@/infrastructure/telemetry/stdout-telemetry";
import { SYSTEM_PROMPT } from "@/agent/system-prompt";
type ToolDetails = import("./tools/index.js").GenerateImageDetails | import("./tools/index.js").ReadPhotoStateDetails | import("./tools/index.js").SelectCandidateDetails;
type ProjectAgentTool = import("@earendil-works/pi-agent-core").AgentTool<import("typebox").TSchema, ToolDetails>;

type AgentModel = AgentState["model"];

export interface AgentSessionEntry {
  type: string;
  seq: number;
  customType?: string;
  data?: unknown;
}

export interface AgentSession {
  findEntriesOnBranch(): Promise<AgentSessionEntry[]>;
  appendMessage(message: unknown): Promise<unknown>;
  appendCustomEntry(customType: string, data: unknown): Promise<unknown>;
}

export interface AgentSessionRepo {
  open(args: { id: string }): Promise<AgentSession>;
  create(args: { id: string }): Promise<AgentSession>;
}

export interface AgentTurnConfig {
  guards: { turnTimeoutMs: number };
}

export interface AgentTurnRequest {
  turnId: string;
  projectId: string;
  userMessage?: string;
}

export interface AgentTurnResult {
  kind: "completed" | "failed" | "aborted";
  fatal: { code: string; message: string } | null;
  error: { code: string; message: string } | null;
  stats: { toolCalls: number; toolErrors: number };
}

export function projectSessionId(projectId: string): string {
  return `project:${projectId}`;
}

async function openOrCreateSession(sessionRepo: AgentSessionRepo, sessionId: string): Promise<AgentSession> {
  try {
    return await sessionRepo.open({ id: sessionId });
  } catch (error) {
    if ((error as { code?: string })?.code !== "not_found") throw error;
    try {
      return await sessionRepo.create({ id: sessionId });
    } catch (createError) {
      if ((createError as { code?: string })?.code !== "already_exists") throw createError;
      return sessionRepo.open({ id: sessionId });
    }
  }
}

function createUserMessage(text: string) {
  return { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() };
}

const IMAGE_PLACEHOLDER = { type: "text" as const, text: "[generated image omitted — bytes live in object storage, ids above]" };

interface ContentBlock {
  type?: string;
}

function stripHistoricalImages<T extends { content?: ContentBlock[] }>(toolResults: T[]) {
  return toolResults.map((result) => ({
    ...result,
    content: (result.content ?? []).map((block) => (block.type === "image" ? IMAGE_PLACEHOLDER : block)),
  }));
}

function durableClone(value: unknown) {
  return JSON.parse(JSON.stringify(value));
}

const KEEP_RECENT_TOOL_RESULTS = 1;

function toolResultsProjector(entry: AgentSessionEntry, index: number, allEntries: AgentSessionEntry[]) {
  if (!Array.isArray(entry.data)) return [];
  let lastKeptIndex = -1;
  for (let i = allEntries.length - 1; i >= 0; i -= 1) {
    if (allEntries[i].type === "custom" && allEntries[i].customType === "tool_results") {
      lastKeptIndex = i;
      break;
    }
  }
  const isMostRecent = index >= lastKeptIndex - (KEEP_RECENT_TOOL_RESULTS - 1);
  return isMostRecent ? entry.data : stripHistoricalImages((entry.data ?? []) as Array<{ content?: ContentBlock[] } & Record<string, unknown>>);
}

export async function runAgentTurn({
  sessionRepo, config, model, turn, tools, streamFn, telemetry = createNoopTelemetry(),
}: {
  sessionRepo: AgentSessionRepo;
  config: AgentTurnConfig;
  model: AgentModel;
  turn: AgentTurnRequest;
  tools: ProjectAgentTool[];
  streamFn: StreamFn;
  telemetry?: TelemetryContext;
}): Promise<AgentTurnResult> {
  return telemetry.startSpan(
    { name: "pi.agent.turn", attributes: { "pi.turn.id": turn.turnId, "pi.project.id": turn.projectId } },
    async (span) => {
      if (!model) throw new TypeError("runAgentTurn requires model");
      const result = await runTurn({ sessionRepo, config, model, turn, tools, streamFn, telemetry });
      span.setAttributes({
        "pi.turn.outcome": result.kind,
        "pi.turn.tool_calls": result.stats.toolCalls,
        "pi.turn.tool_errors": result.stats.toolErrors,
      });
      if (result.kind === "failed") {
        span.setStatus({ status: "error", error: { message: result.fatal?.message ?? "turn failed" } });
      }
      return result;
    },
  );
}

async function runTurn({ sessionRepo, config, model, turn, tools, streamFn, telemetry }: {
  sessionRepo: AgentSessionRepo;
  config: AgentTurnConfig;
  model: AgentModel;
  turn: AgentTurnRequest;
  tools: ProjectAgentTool[];
  streamFn: StreamFn;
  telemetry: TelemetryContext;
}): Promise<AgentTurnResult> {
  const sessionId = projectSessionId(turn.projectId);
  let fatal: { code: string; message: string } | null = null;
  let shouldStop = false;
  let timedOut = false;
  const stats = { toolCalls: 0, toolErrors: 0 };
  let generatedImageCount = 0;
  let streamError: { code: string; message: string } | null = null;

  try {
    const session = await openOrCreateSession(sessionRepo, sessionId);
    const entries = (await session.findEntriesOnBranch())
      .slice()
      .sort((left, right) => left.seq - right.seq);
    const context = buildSessionContext(entries as unknown as Entry[], {
      entryProjectors: { tool_results: toolResultsProjector as never },
    });
    await session.appendMessage(createUserMessage(turn.userMessage ?? ""));
    const agent = new Agent({
      streamFn,
      initialState: {
        systemPrompt: SYSTEM_PROMPT,
        model,
        thinkingLevel: (context.thinkingLevel ?? "off") as ThinkingLevel,
        tools,
        messages: context.messages,
      },
      sessionId,
      shouldStopAfterTurn: () => shouldStop,
    });

    agent.subscribe(async (event: AgentEvent) => {
      if (event.type === "tool_execution_end") {
        stats.toolCalls += 1;
        if (event.isError) stats.toolErrors += 1;
        telemetry.startSpan(
          {
            name: "pi.agent.tool",
            attributes: {
              "pi.turn.id": turn.turnId,
              "pi.project.id": turn.projectId,
              "pi.tool.name": event.toolName,
              "pi.tool.call_id": event.toolCallId,
              "pi.tool.is_error": event.isError,
            },
          },
          () => undefined,
        );
      }
      if (event.type === "tool_execution_end" && event.result?.details?.fatalCode) {
        fatal = { code: event.result.details.fatalCode, message: event.result.content[0]?.text };
        shouldStop = true;
      }
      if (event.type === "tool_execution_end" && event.toolName === "generate_image" && !event.isError) {
        generatedImageCount += 1;
      }
      if (event.type !== "turn_end") return;
      const message = event.message;
      if (!("stopReason" in message)) return;
      if (message.stopReason === "error") {
        streamError = { code: "LLM_STREAM_ERROR", message: message.errorMessage ?? "LLM stream failed" };
        await session.appendCustomEntry("stream_error", { message: message.errorMessage ?? null });
        return;
      }
      await session.appendMessage(durableClone(message));
      if (event.toolResults.length > 0) {
        await session.appendCustomEntry("tool_results", durableClone(stripHistoricalImages(event.toolResults)));
      }
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      agent.abort();
    }, config.guards.turnTimeoutMs);

    try {
      const result = await agent.prompt(turn.userMessage ?? "");
      clearTimeout(timeout);
      if (shouldStop) return { kind: "failed" as const, fatal, error: fatal, stats };
      if (fatal) return { kind: "failed" as const, fatal, error: fatal, stats };
      if (timedOut) {
        return { kind: "aborted" as const, fatal, error: { code: "TURN_TIMEOUT", message: "Turn timed out" }, stats };
      }
      const lastMessage = agent.state.messages.at(-1) as AssistantMessage | undefined;
      if (agent.state.errorMessage || lastMessage?.stopReason === "aborted") {
        return {
          kind: "aborted" as const,
          fatal,
          error: streamError ?? { code: "AGENT_ABORTED", message: agent.state.errorMessage ?? "unknown abort reason" },
          stats,
        };
      }
      if (generatedImageCount === 0) {
        return {
          kind: "failed" as const,
          fatal: null,
          error: { code: "NO_IMAGE_GENERATED", message: "Agent completed without generating a new image" },
          stats,
        };
      }
      return {
        kind: "completed" as const,
        fatal,
        error: null,
        stats,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    if (!fatal && error) {
      fatal = { code: "AGENT_RUN_FAILED", message: (error as Error).message };
    }
    return { kind: "failed" as const, fatal, error: fatal, stats };
  }
}
