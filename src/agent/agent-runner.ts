import { Agent, buildSessionContext } from "@earendil-works/pi-agent-core";
import { createNoopTelemetry } from "../infrastructure/telemetry/stdout-telemetry.js";
import type { TelemetryContext } from "../infrastructure/telemetry/stdout-telemetry.js";
import { SYSTEM_PROMPT } from "./system-prompt.js";

export function projectSessionId(projectId: string): string {
  return `project:${projectId}`;
}

async function openOrCreateSession(sessionRepo: any, sessionId: string) {
  try {
    return await sessionRepo.open({ id: sessionId });
  } catch (error: any) {
    if (error?.code !== "not_found") throw error;
    try {
      return await sessionRepo.create({ id: sessionId });
    } catch (createError: any) {
      if (createError?.code !== "already_exists") throw createError;
      return sessionRepo.open({ id: sessionId });
    }
  }
}

function createUserMessage(text: string) {
  return { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() };
}

const IMAGE_PLACEHOLDER = { type: "text" as const, text: "[generated image omitted — bytes live in object storage, ids above]" };

function stripHistoricalImages(toolResults: any[]) {
  return toolResults.map((result) => ({
    ...result,
    content: (result.content ?? []).map((block: any) => (block.type === "image" ? IMAGE_PLACEHOLDER : block)),
  }));
}

function durableClone(value: unknown) {
  return JSON.parse(JSON.stringify(value));
}

const KEEP_RECENT_TOOL_RESULTS = 1;

function toolResultsProjector(entry: any, index: number, allEntries: any[]) {
  if (!Array.isArray(entry.data)) return [];
  let lastKeptIndex = -1;
  for (let i = allEntries.length - 1; i >= 0; i -= 1) {
    if (allEntries[i].type === "custom" && allEntries[i].customType === "tool_results") {
      lastKeptIndex = i;
      break;
    }
  }
  const isMostRecent = index >= lastKeptIndex - (KEEP_RECENT_TOOL_RESULTS - 1);
  return isMostRecent ? entry.data : stripHistoricalImages(entry.data);
}

export async function runAgentTurn({
  sessionRepo, config, model, turn, tools, streamFn, telemetry = createNoopTelemetry(),
}: {
  sessionRepo: any;
  config: any;
  model: any;
  turn: { turnId: string; projectId: string; userMessage?: string };
  tools: any[];
  streamFn: any;
  telemetry?: TelemetryContext;
}) {
  return telemetry.startSpan(
    { name: "pi.agent.turn", attributes: { "pi.turn.id": turn.turnId, "pi.project.id": turn.projectId } },
    async (span: any) => {
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
  sessionRepo: any; config: any; model: any;
  turn: { turnId: string; projectId: string; userMessage?: string };
  tools: any[]; streamFn: any; telemetry: TelemetryContext;
}) {
  const sessionId = projectSessionId(turn.projectId);
  let fatal: any;
  let shouldStop = false;
  let timedOut = false;
  const stats = { toolCalls: 0, toolErrors: 0 };
  let streamError: any = null;

  try {
    const session = await openOrCreateSession(sessionRepo, sessionId);
    const entries = (await session.findEntriesOnBranch())
      .slice()
      .sort((left: any, right: any) => left.seq - right.seq);
    const context: any = buildSessionContext(entries as any, {
      entryProjectors: { tool_results: toolResultsProjector } as any,
    });
    await session.appendMessage(createUserMessage(turn.userMessage ?? ""));
    const agent = new Agent({
      streamFn,
      initialState: {
        systemPrompt: SYSTEM_PROMPT,
        model,
        thinkingLevel: (context.thinkingLevel ?? "off") as any,
        tools,
        messages: context.messages,
      },
      sessionId,
      shouldStopAfterTurn: () => shouldStop,
    });

    agent.subscribe(async (event: any) => {
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
      if (event.type !== "turn_end") return;
      const message = event.message;
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
      const lastMessage = agent.state.messages.at(-1) as any;
      if (agent.state.errorMessage || lastMessage?.stopReason === "aborted") {
        return {
          kind: "aborted" as const,
          fatal,
          error: streamError ?? { code: "AGENT_ABORTED", message: agent.state.errorMessage ?? "unknown abort reason" },
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
  } catch (error: any) {
    if (fatal === undefined && error) {
      fatal = { code: "AGENT_RUN_FAILED", message: error.message };
    }
    return { kind: "failed" as const, fatal, error: fatal, stats };
  }
}
