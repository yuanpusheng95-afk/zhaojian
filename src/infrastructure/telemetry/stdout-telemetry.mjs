/**
 * 最简 TelemetryContext adapter：每个结束的 span 输出一行结构化 JSON。
 *
 * pi 的 telemetry 包只定义契约，不带 exporter（设计文档 §11.3）。
 * Session 记「Agent 做了什么」，span 记「花了多久、在哪一层失败」——
 * 生图延迟与供应商级失败只在 span 里有（§11.4）。
 *
 * stdout 只走 JSON 行，人类可读日志走 stderr，否则冒烟输出无法 | jq（§12.3）。
 *
 * 契约（packages/telemetry/src/index.ts）是**回调式**的：
 *   startSpan<T>(options: { name, attributes? }, cb: (span) => T | Promise<T>): Promise<T>
 * span 的生命周期就是回调的执行期，没有 end()；TelemetrySpan 自身也是
 * TelemetryContext，因此能开子 span。
 */
export function createStdoutTelemetry({
  write = (line) => process.stdout.write(`${line}\n`),
  now = () => Date.now(),
} = {}) {
  function startSpan(options, callback) {
    const startedAt = now();
    const attributes = { ...(options.attributes ?? {}) };
    const events = [];
    let status = { status: 'ok' };

    const span = {
      startSpan,
      addEvent(name, eventAttributes) {
        events.push({ name, attributes: eventAttributes ?? {} });
      },
      setAttributes(next) {
        Object.assign(attributes, next);
      },
      setStatus(next) {
        status = next;
      },
    };

    const emit = () => {
      write(
        JSON.stringify({
          span: options.name,
          durationMs: now() - startedAt,
          attributes,
          status,
          ...(events.length ? { events } : {}),
        }),
      );
    };

    // 回调抛错时也必须出一行，并记为 error——否则失败的 span 在流水里凭空消失
    let result;
    try {
      result = callback(span);
    } catch (error) {
      span.setStatus({
        status: 'error',
        error: { name: error?.name ?? 'Error', message: error?.message ?? String(error) },
      });
      emit();
      return Promise.reject(error);
    }

    return Promise.resolve(result).then(
      (value) => {
        emit();
        return value;
      },
      (error) => {
        span.setStatus({
          status: 'error',
          error: { name: error?.name ?? 'Error', message: error?.message ?? String(error) },
        });
        emit();
        throw error;
      },
    );
  }

  return { startSpan };
}

/** 测试与 TELEMETRY=noop 时的空实现：span 语义保持，什么都不输出。 */
export function createNoopTelemetry() {
  const noopSpan = {
    startSpan: (_options, callback) => callback(noopSpan),
    addEvent() {},
    setAttributes() {},
    setStatus() {},
  };
  return { startSpan: (_options, callback) => callback(noopSpan) };
}
