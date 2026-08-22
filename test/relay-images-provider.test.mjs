import assert from 'node:assert/strict';
import { test } from 'node:test';

import { relayGenerateImages } from '../src/infrastructure/models/relay-images-provider.mjs';

/** baseUrl 带 /v1，覆盖「中转站已含版本段」这种常见写法。 */
const MODEL = {
  id: 'gpt-image-2',
  name: 'GPT Image 2',
  api: 'relay-openai-images',
  provider: 'relay',
  baseUrl: 'https://relay.example.com/v1',
  input: ['text', 'image'],
  output: ['image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const PNG_B64 = 'iVBORw0KGgo=';

function contextWith(text, imageBase64) {
  const input = [{ type: 'text', text }];
  if (imageBase64) {
    input.push({ type: 'image', data: imageBase64, mimeType: 'image/png' });
  }
  return { input };
}

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return { fetchImpl, calls };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function markdownImageResponse(base64, mime = 'image/png') {
  return jsonResponse(200, {
    choices: [
      {
        message: {
          role: 'assistant',
          content: `![image_1](data:${mime};base64,${base64})`,
        },
      },
    ],
  });
}

test('img2img goes through chat/completions and never doubles the /v1 segment', async () => {
  const { fetchImpl, calls } = fakeFetch(() => markdownImageResponse(PNG_B64));

  await relayGenerateImages(MODEL, contextWith('海边黄昏', PNG_B64), {
    apiKey: 'k',
    fetch: fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://relay.example.com/v1/chat/completions');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'gpt-image-2');
  const content = body.messages[0].content;
  assert.equal(content[0].text, '海边黄昏');
  assert.equal(content[1].image_url.url, `data:image/png;base64,${PNG_B64}`);
});

test('parses the markdown data URI the relay embeds in message.content', async () => {
  const { fetchImpl } = fakeFetch(() => markdownImageResponse(PNG_B64, 'image/webp'));

  const result = await relayGenerateImages(MODEL, contextWith('x', PNG_B64), {
    apiKey: 'k',
    fetch: fetchImpl,
  });

  assert.equal(result.stopReason, 'stop');
  assert.deepEqual(result.output, [
    { type: 'image', data: PNG_B64, mimeType: 'image/webp' },
  ]);
});

test('text-only requests use images/generations with an explicit size', async () => {
  const { fetchImpl, calls } = fakeFetch(() =>
    jsonResponse(200, { data: [{ b64_json: PNG_B64 }] }),
  );

  const result = await relayGenerateImages(MODEL, contextWith('凭空生成'), {
    apiKey: 'k',
    fetch: fetchImpl,
    size: '1024x1024',
  });

  assert.equal(calls[0].url, 'https://relay.example.com/v1/images/generations');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(
    body.size,
    '1024x1024',
    'size must never be omitted or auto — the relay times out and returns 502',
  );
  assert.deepEqual(result.output[0], {
    type: 'image',
    data: PNG_B64,
    mimeType: 'image/png',
  });
});

test('editRoute=edits switches img2img to the standard multipart endpoint', async () => {
  const { fetchImpl, calls } = fakeFetch(() =>
    jsonResponse(200, { data: [{ b64_json: PNG_B64 }] }),
  );

  const result = await relayGenerateImages(MODEL, contextWith('海边', PNG_B64), {
    apiKey: 'k',
    fetch: fetchImpl,
    editRoute: 'edits',
    size: '1024x1024',
  });

  assert.equal(calls[0].url, 'https://relay.example.com/v1/images/edits');
  const form = calls[0].init.body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get('prompt'), '海边');
  assert.equal(form.get('size'), '1024x1024');
  assert.ok(form.get('image'), 'base image must be attached');
  assert.equal(result.output[0].data, PNG_B64);
});

test('a chat response carrying no image is reported as an error, not silent success', async () => {
  const { fetchImpl } = fakeFetch(() =>
    jsonResponse(200, {
      choices: [{ message: { role: 'assistant', content: '{"size":"auto","n":1,' } }],
    }),
  );

  const result = await relayGenerateImages(MODEL, contextWith('x', PNG_B64), {
    apiKey: 'k',
    fetch: fetchImpl,
  });

  assert.equal(result.stopReason, 'error');
  assert.match(result.errorMessage, /no image/i);
  assert.equal(result.output.length, 0);
});

test('reports auth failures as an error result instead of throwing', async () => {
  const { fetchImpl } = fakeFetch(() =>
    jsonResponse(401, { error: { message: 'invalid api key' } }),
  );

  const result = await relayGenerateImages(MODEL, contextWith('x', PNG_B64), {
    apiKey: 'bad',
    fetch: fetchImpl,
  });

  assert.equal(result.stopReason, 'error');
  assert.match(result.errorMessage, /invalid api key/);
});

test('reports a non-JSON edge failure without crashing on the parse', async () => {
  const { fetchImpl } = fakeFetch(
    () => new Response('error code: 502', { status: 502, headers: { 'Content-Type': 'text/plain' } }),
  );

  const result = await relayGenerateImages(MODEL, contextWith('x', PNG_B64), {
    apiKey: 'k',
    fetch: fetchImpl,
  });

  assert.equal(result.stopReason, 'error');
  assert.match(result.errorMessage, /502/);
});

test('abort surfaces as stopReason aborted', async () => {
  const { fetchImpl } = fakeFetch(() => {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    throw error;
  });

  const result = await relayGenerateImages(MODEL, contextWith('x', PNG_B64), {
    apiKey: 'k',
    fetch: fetchImpl,
  });

  assert.equal(result.stopReason, 'aborted');
});
