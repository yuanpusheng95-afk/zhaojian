import { Agent, buildSessionContext } from '@earendil-works/pi-agent-core';
import { createNoopTelemetry } from '../infrastructure/telemetry/stdout-telemetry.mjs';
import { SYSTEM_PROMPT } from './system-prompt.mjs';

export function projectSessionId(projectId) {
  return `project:${projectId}`;
}

async function openOrCreateSession(sessionRepo, sessionId) {
  try {
    return await sessionRepo.open({ id: sessionId });
  } catch (error) {
    if (error?.code !== 'not_found') throw error;
    try {
      return await sessionRepo.create({ id: sessionId });
    } catch (createError) {
      if (createError?.code !== 'already_exists') throw createError;
      return sessionRepo.open({ id: sessionId });
    }
  }
}

function createUserMessage(text) {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() };
}

function durableClone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** 历史轮次的生成图不进上下文/不落库:字节在对象存储(§6.1),模型当场看过的图由 pi 的内存上下文承载。 */
const IMAGE_PLACEHOLDER = { type: 'text', text: '[generated image omitted — bytes live in object storage, ids above]' };

function stripHistoricalImages(toolResults) {
  return toolResults.map((result) => ({
    ...result,
    content: (result.content ?? []).map((block) => (block.type === 'image' ? IMAGE_PLACEHOLDER : block)),
  }));
}

/** 最近一组 tool_results 保留原图(轮开始时模型能看到上一轮产物),更早的替换为占位符。 */
const KEEP_RECENT_TOOL_RESULTS = 1;

function toolResultsProjector(entry, index, allEntries) {
  if (!Array.isArray(entry.data)) return [];
  let lastKeptIndex = -1;
  for (let i = allEntries.length - 1; i >= 0; i -= 1) {
    if (allEntries[i].type === 'custom' && allEntries[i].customType === 'tool_results') {
      lastKeptIndex = i;
      break;
    }
  }
  const isMostRecent = index >= lastKeptIndex - (KEEP_RECENT_TOOL_RESULTS - 1);
  return isMostRecent ? entry.data : stripHistoricalImages(entry.data);
}

export async function runAgentTurn({
  sessionRepo,
  config,
  model,
  turn,
  tools,
  streamFn,
  telemetry = createNoopTelemetry(),
}) {
  return telemetry.startSpan(
    { name: 'pi.agent.turn', attributes: { 'pi.turn.id': turn.turnId, 'pi.project.id': turn.projectId } },
    async (span) => {
      if (!model) throw new TypeError('runAgentTurn requires model');
      const result = await runTurn({ sessionRepo, config, model, turn, tools, streamFn, telemetry });
      span.setAttributes({
        'pi.turn.outcome': result.kind,
        'pi.turn.tool_calls': result.stats.toolCalls,
        'pi.turn.tool_errors': result.stats.toolErrors,
      });
      if (result.kind === 'failed') {
        span.setStatus({ status: 'error', error: { message: result.fatal?.message ?? 'turn failed' } });
      }
      return result;
    },
  );
}

async function runTurn({ sessionRepo, config, model, turn, tools, streamFn, telemetry }) {
  const sessionId = projectSessionId(turn.projectId);
  let fatal;
  let shouldStop = false;
  let timedOut = false;
  const stats = { toolCalls: 0, toolErrors: 0 };
  let streamError = null;
  let session;
  try {
    session = await openOrCreateSession(sessionRepo, sessionId);
    // 先构建上下文、后追加用户消息：initialState 不能含本轮消息，
    // 否则 agent.prompt() 会再加一次，模型看到两条相同的用户消息。
    // 按 seq 显式升序：pi 的 InMemory 后端 findEntriesOnBranch 返回 leaf→root 降序，
    // Postgres 后端返回升序——排序放这里，调用方就不依赖后端行为
    const entries = (await session.findEntriesOnBranch())
      .slice()
      .sort((left, right) => left.seq - right.seq);
    const context = buildSessionContext(entries, {
      entryProjectors: {
        tool_results: toolResultsProjector,
      },
    });
    await session.appendMessage(createUserMessage(turn.userMessage));
    const agent = new Agent({
      streamFn,
      initialState: {
        systemPrompt: SYSTEM_PROMPT,
        model,
        thinkingLevel: context.thinkingLevel ?? 'off',
        tools,
        messages: context.messages,
      },
      sessionId,
      shouldStopAfterTurn: () => shouldStop,
    });

    agent.subscribe(async (event) => {
      if (event.type === 'tool_execution_end') {
        stats.toolCalls += 1;
        if (event.isError) stats.toolErrors += 1;
        telemetry.startSpan(
          {
            name: 'pi.agent.tool',
            attributes: {
              'pi.turn.id': turn.turnId,
              'pi.project.id': turn.projectId,
              'pi.tool.name': event.toolName,
              'pi.tool.call_id': event.toolCallId,
              'pi.tool.is_error': event.isError,
            },
          },
          () => undefined,
        );
      }
      if (event.type === 'tool_execution_end' && event.result?.details?.fatalCode) {
        fatal = { code: event.result.details.fatalCode, message: event.result.content[0]?.text };
        shouldStop = true;
      }
      if (event.type !== 'turn_end') return;
      const message = event.message;
      if (message.stopReason === 'error') {
        // 错误的 assistant(通常 0 内容块)不进轨迹——持久化它只会污染后续轮次的上下文;
        // 错误细节以 stream_error 自定义条目落库,排障时查得到
        streamError = { code: 'LLM_STREAM_ERROR', message: message.errorMessage ?? 'LLM stream failed' };
        await session.appendCustomEntry('stream_error', { message: message.errorMessage ?? null });
        return;
      }
      await session.appendMessage(durableClone(message));
      if (event.toolResults.length > 0) {
        // 生图字节不落轨迹:session 只记"生成了图 + 是哪张"(ID 文本块),
        // base64 每轮随历史重传是 LLM 请求 2 分钟/次的实测根因
        await session.appendCustomEntry('tool_results', durableClone(stripHistoricalImages(event.toolResults)));
      }
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      agent.abort();
    }, config.guards.turnTimeoutMs);
    try {
      await agent.prompt(turn.userMessage);
      if (shouldStop) return { kind: 'failed', fatal, error: fatal, stats };
      if (fatal) return { kind: 'failed', fatal, error: fatal, stats };
      if (timedOut) {
        return { kind: 'aborted', fatal, error: { code: 'TURN_TIMEOUT', message: 'Turn timed out' }, stats };
      }
      const lastMessage = agent.state.messages.at(-1);
      if (agent.state.errorMessage || lastMessage?.stopReason === 'aborted') {
        return {
          kind: 'aborted',
          fatal,
          error: streamError ?? { code: 'AGENT_ABORTED', message: agent.state.errorMessage ?? 'unknown abort reason' },
          stats,
        };
      }
      return { kind: 'completed', fatal, error: null, stats };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    return {
      kind: 'failed',
      fatal: { code: 'AGENT_RUN_FAILED', message: error?.message ?? String(error) },
      error: { code: 'AGENT_RUN_FAILED', message: error?.message ?? String(error) },
      stats,
    };
  }
}
