import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NOOP_TELEMETRY_CONTEXT } from '@earendil-works/pi-agent-core';

import { createStdoutTelemetry } from '../src/infrastructure/telemetry/stdout-telemetry.mjs';

function collector() {
  const lines = [];
  return { lines, write: (line) => lines.push(line) };
}

test('matches the callback-style TelemetryContext contract', async () => {
  const telemetry = createStdoutTelemetry({ write: () => {} });

  // 与 pi 的 NOOP 实现比对：契约要求 startSpan(options, cb) 返回 Promise
  assert.equal(typeof telemetry.startSpan, 'function');
  const returned = telemetry.startSpan({ name: 'probe' }, () => 'value');
  assert.ok(returned instanceof Promise, 'startSpan must return a Promise');
  assert.equal(await returned, 'value', 'callback result must pass through');

  await NOOP_TELEMETRY_CONTEXT.startSpan({ name: 'probe' }, (span) => {
    for (const method of ['startSpan', 'addEvent', 'setAttributes', 'setStatus']) {
      assert.equal(typeof span[method], 'function', `noop span exposes ${method}`);
    }
  });
});

test('emits one JSON line per finished span with a duration', async () => {
  const sink = collector();
  let clock = 1000;
  const telemetry = createStdoutTelemetry({
    write: sink.write,
    now: () => clock,
  });

  await telemetry.startSpan(
    { name: 'pi.harness.tool', attributes: { 'pi.tool.name': 'generate_image' } },
    () => {
      clock += 42;
    },
  );

  assert.equal(sink.lines.length, 1);
  const parsed = JSON.parse(sink.lines[0]);
  assert.equal(parsed.span, 'pi.harness.tool');
  assert.equal(parsed.attributes['pi.tool.name'], 'generate_image');
  assert.equal(parsed.durationMs, 42);
  assert.deepEqual(parsed.status, { status: 'ok' });
});

test('the span itself can open child spans, innermost finishing first', async () => {
  const sink = collector();
  const telemetry = createStdoutTelemetry({ write: sink.write, now: () => 0 });

  await telemetry.startSpan({ name: 'pi.harness.run' }, async (span) => {
    await span.startSpan({ name: 'pi.harness.tool' }, () => {});
  });

  assert.deepEqual(
    sink.lines.map((line) => JSON.parse(line).span),
    ['pi.harness.tool', 'pi.harness.run'],
  );
});

test('records attributes and events added during the callback', async () => {
  const sink = collector();
  const telemetry = createStdoutTelemetry({ write: sink.write, now: () => 0 });

  await telemetry.startSpan({ name: 'pi.ai.request' }, (span) => {
    span.setAttributes({ 'pi.ai.operation': 'generate_images' });
    span.addEvent('retry.scheduled', { attempt: 1 });
  });

  const parsed = JSON.parse(sink.lines[0]);
  assert.equal(parsed.attributes['pi.ai.operation'], 'generate_images');
  assert.deepEqual(parsed.events, [
    { name: 'retry.scheduled', attributes: { attempt: 1 } },
  ]);
});

test('a throwing callback still emits a line, marked as error, and rethrows', async () => {
  const sink = collector();
  const telemetry = createStdoutTelemetry({ write: sink.write, now: () => 0 });

  await assert.rejects(
    () =>
      telemetry.startSpan({ name: 'pi.harness.run' }, () => {
        throw new Error('provider unavailable');
      }),
    /provider unavailable/,
  );

  assert.equal(sink.lines.length, 1, 'a failed span must not vanish from the stream');
  const parsed = JSON.parse(sink.lines[0]);
  assert.equal(parsed.status.status, 'error');
  assert.equal(parsed.status.error.message, 'provider unavailable');
});

test('a rejecting async callback is handled the same way', async () => {
  const sink = collector();
  const telemetry = createStdoutTelemetry({ write: sink.write, now: () => 0 });

  await assert.rejects(
    () =>
      telemetry.startSpan({ name: 'pi.ai.request' }, async () => {
        throw new Error('429 slow down');
      }),
    /slow down/,
  );

  const parsed = JSON.parse(sink.lines[0]);
  assert.equal(parsed.status.status, 'error');
});

test('every emitted line is valid JSON so the stream stays jq-parseable', async () => {
  const sink = collector();
  const telemetry = createStdoutTelemetry({ write: sink.write, now: () => 0 });

  await telemetry.startSpan({ name: 'pi.harness.run' }, async (span) => {
    span.addEvent('note', { text: 'contains "quotes" and \n newlines' });
    await span.startSpan({ name: 'pi.harness.tool' }, () => {});
  });

  for (const line of sink.lines) {
    assert.doesNotThrow(() => JSON.parse(line), `not JSON: ${line}`);
    assert.ok(!line.includes('\n'), 'each span must occupy exactly one line');
  }
});
