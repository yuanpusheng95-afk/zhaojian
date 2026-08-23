import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

function assistantMessage(model, content, stopReason) {
  return {
    role: 'assistant',
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

export function createFakeStreamFn(script) {
  const calls = [];
  const streamFn = async (model, context, options) => {
    if (options?.signal?.aborted) throw new Error('aborted');
    calls.push({ context });
    const step = script.shift();
    if (!step) throw new Error('No more fake stream steps');
    const message = assistantMessage(model, step.content ?? [], step.stopReason ?? 'stop');
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      let partial = { ...message, content: [], stopReason: 'pending' };
      stream.push({ type: 'start', partial });
      for (const block of message.content) {
        const index = partial.content.length;
        if (block.type === 'text') {
          partial = { ...partial, content: [...partial.content, { type: 'text', text: '' }] };
          stream.push({ type: 'text_start', contentIndex: index, partial });
          stream.push({ type: 'text_delta', contentIndex: index, delta: block.text, partial });
          partial.content[index].text = block.text;
          stream.push({ type: 'text_end', contentIndex: index, content: block.text, partial });
        } else {
          partial = { ...partial, content: [...partial.content, { ...block, arguments: {} }] };
          stream.push({ type: 'toolcall_start', contentIndex: index, partial });
          partial.content[index].arguments = block.arguments;
          stream.push({ type: 'toolcall_end', contentIndex: index, toolCall: block, partial });
        }
      }
      stream.push({ type: 'done', reason: message.stopReason, message });
      stream.end(message);
    });
    return stream;
  };
  streamFn.calls = calls;
  return streamFn;
}
