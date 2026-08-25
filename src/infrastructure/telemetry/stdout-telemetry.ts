export interface SpanOptions {
  name: string;
  attributes?: Record<string, unknown>;
}

export interface TelemetrySpan {
  startSpan: <T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>) => Promise<T>;
  addEvent(name: string, attributes?: Record<string, unknown>): void;
  setAttributes(next: Record<string, unknown>): void;
  setStatus(next: { status: string; error?: Record<string, unknown> }): void;
}

export interface TelemetryContext {
  startSpan: <T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>) => Promise<T>;
}

type WriteFn = (line: string) => void;

export function createStdoutTelemetry({
  write = (line: string) => process.stdout.write(`${line}\n`),
  now = () => Date.now(),
}: {
  write?: WriteFn;
  now?: () => number;
} = {}): TelemetryContext {
  function startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
    const startedAt = now();
    const attributes: Record<string, unknown> = { ...(options.attributes ?? {}) };
    const events: Array<{ name: string; attributes?: Record<string, unknown> }> = [];
    let status: { status: string; error?: Record<string, unknown> } = { status: "ok" };

    const span: TelemetrySpan = {
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
      write(JSON.stringify({
        span: options.name,
        durationMs: now() - startedAt,
        attributes,
        status,
        ...(events.length ? { events } : {}),
      }));
    };

    let result: T | Promise<T>;
    try {
      result = callback(span);
    } catch (error) {
      span.setStatus(toErrorStatus(error));
      emit();
      return Promise.reject(error);
    }

    return Promise.resolve(result).then(
      (value) => { emit(); return value; },
      (error: unknown) => {
        span.setStatus(toErrorStatus(error));
        emit();
        throw error;
      },
    );
  }

  return { startSpan };
}

function toErrorStatus(error: unknown): { status: string; error: Record<string, unknown> } {
  if (error instanceof Error) {
    return { status: "error", error: { name: error.name, message: error.message } };
  }
  return { status: "error", error: { name: "Error", message: String(error) } };
}

export function createNoopTelemetry(): TelemetryContext {
  const noopSpan: TelemetrySpan = {
    startSpan: async (_options, callback) => callback(noopSpan),
    addEvent() {},
    setAttributes() {},
    setStatus() {},
  };
  return { startSpan: async (_options, callback) => callback(noopSpan) };
}
