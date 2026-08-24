import assert from 'node:assert/strict';
import { describe, expect, test } from 'bun:test';

import { instrumentStreamFn } from '../src/infrastructure/telemetry/stream-fn.js';
import { createNoopTelemetry } from '../src/infrastructure/telemetry/stdout-telemetry.js';
import { createTeeTelemetry } from '../src/infrastructure/telemetry/pg-telemetry.js';

test('tee telemetry runs the callback once and emits to every sink', async () => {
  const emitted = [];
  const recording = (label) => ({
    startSpan: (options, callback) => {
      const span = {
        setAttributes() {}, addEvent() {}, setStatus() {},
        startSpan: () => {},
      };
      return Promise.resolve(callback(span)).then((value) => {
        emitted.push(label);
        return value;
      });
    },
  });
  const tee = createTeeTelemetry([recording('a'), recording('b'), createNoopTelemetry()]);

  let callbackRuns = 0;
  const result = await tee.startSpan({ name: 'x' }, async () => {
    callbackRuns += 1;
    return 'value';
  });

  assert.equal(result, 'value');
  assert.equal(callbackRuns, 1);
  assert.deepEqual([...emitted].sort(), ['a', 'b']);
});

test('instrumentStreamFn spans carry turn attributes and returns the successful stream', async () => {
  const spans = [];
  const telemetry = {
    startSpan: (options, callback) => {
      const span = {
        attrs: { ...options.attributes }, events: [],
        setAttributes(next) { Object.assign(span.attrs, next); },
        addEvent(name, attrs) { span.events.push({ name, attrs }); },
        setStatus() {},
        startSpan() {},
      };
      spans.push({ name: options.name, span });
      return callback(span);
    },
  };
  const okMessage = { stopReason: 'stop', content: [] };
  const streamFn = async () => ({ result: () => Promise.resolve(okMessage) });
  const wrapped = instrumentStreamFn({
    telemetry, streamFn,
    attributes: { 'pi.turn.id': 'turn_x', 'pi.project.id': 'p1' },
  });

  const stream = await wrapped({ provider: 'deepseek', id: 'm1' }, {}, undefined);

  assert.equal(await stream.result(), okMessage);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].name, 'pi.ai.request');
  assert.equal(spans[0].span.attrs['pi.turn.id'], 'turn_x');
  assert.equal(spans[0].span.attrs['pi.project.id'], 'p1');
  assert.equal(spans[0].span.attrs['pi.model.id'], 'm1');
});

test('instrumentStreamFn retries retryable stream errors and gives up after the cap', async () => {
  const spans = [];
  const telemetry = {
    startSpan: (options, callback) => {
      const span = {
        attrs: { ...options.attributes }, events: [],
        setAttributes(next) { Object.assign(span.attrs, next); },
        addEvent(name, attrs) { span.events.push({ name, attrs }); },
        setStatus() {},
        startSpan() {},
      };
      spans.push({ name: options.name, span });
      return callback(span);
    },
  };
  const attempts = [];
  const streamFn = async () => {
    attempts.push(1);
    const failed = attempts.length <= 2;
    return {
      result: () => Promise.resolve(failed
        ? { stopReason: 'error', errorMessage: 'HTTP 429 rate limit exceeded' }
        : { stopReason: 'stop' }),
    };
  };
  const sleeps = [];
  const wrapped = instrumentStreamFn({
    telemetry, streamFn, maxRetries: 2, backoffBaseMs: 10,
    sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
  });

  const stream = await wrapped({ provider: 'deepseek', id: 'm1' }, {}, undefined);
  assert.equal((await stream.result()).stopReason, 'stop');
  assert.equal(attempts.length, 3, 'two failures then success');
  assert.deepEqual(sleeps, [10, 20]);
  assert.equal(spans[0].span.events.length, 2, 'each retry recorded as an event');
  assert.equal(spans[0].span.attrs['pi.ai.attempt'], 3);
});

test('instrumentStreamFn does not retry non-retryable stream errors', async () => {
  const telemetry = { startSpan: (_o, cb) => cb({ setAttributes() {}, addEvent() {}, setStatus() {}, startSpan() {} }) };
  let calls = 0;
  const streamFn = async () => {
    calls += 1;
    return { result: () => Promise.resolve({ stopReason: 'error', errorMessage: 'invalid api key' }) };
  };
  const wrapped = instrumentStreamFn({ telemetry, streamFn, maxRetries: 2, sleep: () => Promise.resolve() });

  const stream = await wrapped({ provider: 'deepseek', id: 'm1' }, {}, undefined);
  assert.equal((await stream.result()).errorMessage, 'invalid api key');
  assert.equal(calls, 1);
});
