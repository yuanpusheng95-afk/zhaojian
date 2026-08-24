import assert from 'node:assert/strict';
import { describe, expect, test } from 'bun:test';

import { InMemorySessionRepo, SessionError } from '@earendil-works/pi-agent-core';

import { runAgentTurn } from '../src/agent/agent-runner.js';
import { createFakeStreamFn } from '../test/support/fake-stream-fn.mjs';

const config = {
  guards: { turnTimeoutMs: 1000 },
};
const model = { id: 'fake-model', api: 'fake-api', provider: 'fake' };

function toolCall(id, name, args) {
  return { type: 'toolCall', id, name, arguments: args };
}

function usage() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

test('runAgentTurn persists the user prompt and assistant turns for later visibility', async () => {
  const sessionRepo = new InMemorySessionRepo();
  const streamFn = createFakeStreamFn([
    {
      stopReason: 'toolUse',
      content: [toolCall('call_1', 'read_photo_state', {})],
    },
    {
      stopReason: 'stop',
      content: [{ type: 'text', text: 'done' }],
    },
  ]);
  const tools = [{
    name: 'read_photo_state',
    description: 'read state',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => ({
      content: [{ type: 'text', text: '{}' }],
      details: {},
    }),
  }];

  const first = await runAgentTurn({
    sessionRepo, config, model, turn: { projectId: 'p1', userMessage: 'make it warmer' }, tools, streamFn,
  });
  assert.equal(first.kind, 'completed');
  assert.equal(streamFn.calls.length, 2);

  const second = await runAgentTurn({
    sessionRepo, config, model, turn: { projectId: 'p1', userMessage: 'select it' }, tools,
    streamFn: createFakeStreamFn([{ stopReason: 'stop', content: [{ type: 'text', text: 'ok' }] }]),
  });

  const entries = (await (await sessionRepo.open({ id: 'project:p1' })).findEntriesOnBranch())
    .slice()
    .sort((left, right) => left.seq - right.seq);
  const messages = entries.filter((entry) => entry.type === 'message').map((entry) => entry.message);
  assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant', 'assistant', 'user', 'assistant']);
  const persistedToolResults = entries.filter((entry) => entry.type === 'custom' && entry.customType === 'tool_results');
  assert.equal(persistedToolResults.length, 1);
  assert.equal(persistedToolResults[0].data[0].role, 'toolResult');
  assert.equal(second.kind, 'completed');

  const third = await runAgentTurn({
    sessionRepo, config, model, turn: { projectId: 'p1', userMessage: 'again' }, tools,
    streamFn: createFakeStreamFn([{ stopReason: 'stop', content: [{ type: 'text', text: 'seen' }] }]),
  });
  assert.equal(third.kind, 'completed');
});

test('runAgentTurn recovers from a first-session create race', async () => {
  const created = new InMemorySessionRepo();
  const racing = new InMemorySessionRepo();
  await racing.create({ id: 'project:p1' });
  await created.create({ id: 'project:p1' });
  let opened = false;
  const sessionRepo = {
    open: async ({ id }) => {
      if (!opened) {
        opened = true;
        throw new SessionError('not_found', 'not found');
      }
      return created.open({ id });
    },
    create: async ({ id }) => {
      try {
        return await racing.create({ id });
      } catch (error) {
        if (error.code !== 'already_exists') throw error;
        return created.open({ id });
      }
    },
  };
  const result = await runAgentTurn({
    sessionRepo,
    config,
    model,
    turn: { projectId: 'p1', userMessage: 'hello' },
    tools: [],
    streamFn: createFakeStreamFn([{ stopReason: 'stop', content: [{ type: 'text', text: 'hi' }] }]),
  });
  assert.equal(result.kind, 'completed');
  const entries = await (await created.open({ id: 'project:p1' })).findEntriesOnBranch();
  const roles = entries.filter((entry) => entry.type === 'message').map((entry) => entry.message.role);
  assert.equal(roles.filter((role) => role === 'user').length, 1);
});

test('runAgentTurn sends the user message to the model exactly once', async () => {
  const sessionRepo = new InMemorySessionRepo();
  const streamFn = createFakeStreamFn([
    { stopReason: 'toolUse', content: [toolCall('call_1', 'read_photo_state', {})] },
    { stopReason: 'stop', content: [{ type: 'text', text: 'done' }] },
  ]);
  const tools = [{
    name: 'read_photo_state',
    description: 'read state',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => ({ content: [{ type: 'text', text: '{}' }], details: {} }),
  }];

  const result = await runAgentTurn({
    sessionRepo, config,
    model,
    turn: { projectId: 'p1', userMessage: 'make it warmer' },
    tools, streamFn,
  });
  assert.equal(result.kind, 'completed');
  assert.ok(streamFn.calls.length >= 2);
  for (const call of streamFn.calls) {
    const roles = call.context.messages.map((message) => message.role);
    assert.equal(roles.filter((role) => role === 'user').length, 1,
      `expected exactly one user message, got: ${JSON.stringify(roles)}`);
  }
});

test('runAgentTurn reports aborted when the turn timeout fires', async () => {
  const sessionRepo = new InMemorySessionRepo();
  const streamFn = createFakeStreamFn([
    { stopReason: 'toolUse', content: [toolCall('call_1', 'wait_forever', {})] },
  ]);
  const tools = [{
    name: 'wait_forever',
    description: 'wait forever',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: (_callId, _params, signal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        reject(new Error('aborted'));
      });
    }),
  }];

  const result = await runAgentTurn({
    sessionRepo,
    model,
    config: { guards: { turnTimeoutMs: 10 } },
    turn: { projectId: 'p1', userMessage: 'too slow' },
    tools,
    streamFn,
  });

  assert.equal(result.kind, 'aborted');
});

test('runAgentTurn surfaces stream errors without polluting the trajectory', async () => {
  const sessionRepo = new InMemorySessionRepo();
  const streamFn = async (model) => {
    const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai');
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const message = {
        role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'error', errorMessage: 'HTTP 429 rate limit exceeded', timestamp: Date.now(),
      };
      stream.push({ type: 'done', reason: 'error', message });
      stream.end(message);
    });
    return stream;
  };

  const result = await runAgentTurn({
    sessionRepo, config, model,
    turn: { projectId: 'p1', userMessage: 'hello' },
    tools: [], streamFn,
  });
  assert.equal(result.kind, 'aborted');
  assert.equal(result.error.code, 'LLM_STREAM_ERROR');
  assert.match(result.error.message, /429/);

  const session = await sessionRepo.open({ id: 'project:p1' });
  const entries = (await session.findEntriesOnBranch()).slice().sort((a, b) => a.seq - b.seq);
  const messageRoles = entries.filter((e) => e.type === 'message').map((e) => e.message.role);
  assert.deepEqual(messageRoles, ['user'], 'error assistant must not be persisted as a message');
  const streamErrors = entries.filter((e) => e.customType === 'stream_error');
  assert.equal(streamErrors.length, 1);
  assert.match(streamErrors[0].data.message, /429/);
  assert.equal(typeof result.stats.toolCalls, 'number');
});

test('tool execution spans carry turn attribution', async () => {
  const spans = [];
  const telemetry = {
    startSpan: (options, callback) => {
      const span = { name: options.name, attrs: { ...options.attributes }, setAttributes(next) { Object.assign(span.attrs, next); }, addEvent() {}, setStatus() {}, startSpan() {} };
      spans.push(span);
      return callback(span);
    },
  };
  const tools = [{
    name: 'read_photo_state',
    description: 'read state',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => ({ content: [{ type: 'text', text: '{}' }], details: {} }),
  }];

  const result = await runAgentTurn({
    sessionRepo: new InMemorySessionRepo(),
    config,
    model,
    turn: { projectId: 'p9', turnId: 'turn_tool_span', userMessage: 'look' },
    tools,
    telemetry,
    streamFn: createFakeStreamFn([
      { stopReason: 'toolUse', content: [toolCall('call_1', 'read_photo_state', {})] },
      { stopReason: 'stop', content: [{ type: 'text', text: 'done' }] },
    ]),
  });
  assert.equal(result.kind, 'completed');

  const toolSpan = spans.find((span) => span.name === 'pi.agent.tool');
  assert.ok(toolSpan, 'tool span emitted');
  assert.equal(toolSpan.attrs['pi.turn.id'], 'turn_tool_span');
  assert.equal(toolSpan.attrs['pi.project.id'], 'p9');
  assert.equal(toolSpan.attrs['pi.tool.name'], 'read_photo_state');
});

test('historical image bytes are stripped from persistence and from later contexts', async () => {
  const sessionRepo = new InMemorySessionRepo();
  const imageTool = [{
    name: 'make_image',
    description: 'make',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => ({
      content: [
        { type: 'text', text: '{"generationId":"g1","candidateId":"c1"}' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      ],
      details: {},
    }),
  }];

  await runAgentTurn({
    sessionRepo, config, model,
    turn: { projectId: 'p1', userMessage: 'make one' },
    tools: imageTool,
    streamFn: createFakeStreamFn([
      { stopReason: 'toolUse', content: [toolCall('call_1', 'make_image', {})] },
      { stopReason: 'stop', content: [{ type: 'text', text: 'made' }] },
    ]),
  });

  // 落库侧:持久化的 tool_results 不含 image 块
  const session = await sessionRepo.open({ id: 'project:p1' });
  const persisted = (await session.findEntriesOnBranch())
    .filter((entry) => entry.customType === 'tool_results');
  assert.equal(persisted.length, 1);
  const persistedBlocks = persisted[0].data[0].content;
  assert.equal(persistedBlocks.some((block) => block.type === 'image'), false);
  assert.equal(persistedBlocks[0].type, 'text', 'id 文本块保留');
  assert.match(persistedBlocks[1].text, /object storage/);

  // 上下文侧:第二轮 LLM 看到的是占位符,不是 base64
  const seenRoles = [];
  const wrapped = async (model, context, options) => {
    const images = context.messages.flatMap((m) => (m.content ?? [])).filter((b) => b.type === 'image');
    seenRoles.push(images.length);
    return createFakeStreamFn([{ stopReason: 'stop', content: [{ type: 'text', text: 'ok' }] }])(model, context, options);
  };
  const second = await runAgentTurn({
    sessionRepo, config, model,
    turn: { projectId: 'p1', userMessage: 'again' },
    tools: [], streamFn: wrapped,
  });
  assert.equal(second.kind, 'completed');
  assert.deepEqual(seenRoles, [0], 'no image blocks reach the model on the next turn');
});
