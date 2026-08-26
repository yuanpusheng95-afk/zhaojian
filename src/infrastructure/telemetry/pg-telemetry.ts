import type { Pool } from "pg";
import type { SpanOptions, TelemetryContext, TelemetrySpan } from "@/infrastructure/telemetry/stdout-telemetry";

export function createPgTelemetry({ pool, now = () => Date.now() }: {
  pool: Pool; now?: () => number;
}): TelemetryContext & { drain: (timeoutMs?: number) => Promise<void> } {
  if (!pool) throw new TypeError("createPgTelemetry requires a pg pool");

  const pending = new Set<Promise<unknown>>();

  function startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
    const startedAt = now();
    const attributes: Record<string, unknown> = { ...(options.attributes ?? {}) };
    const events: Array<{ name: string; attributes?: Record<string, unknown> }> = [];
    let status: { status: string; error?: Record<string, unknown> } = { status: "ok" };

    const span = {
      startSpan,
      addEvent(name: string, eventAttributes?: Record<string, unknown>) {
        events.push({ name, attributes: eventAttributes ?? {} });
      },
      setAttributes(next: Record<string, unknown>) {
        Object.assign(attributes, next);
      },
      setStatus(next: { status: string; error?: Record<string, unknown> }) {
        status = next;
      },
    };

    const persist = () => {
      const turnId = attributes["pi.turn.id"] ?? null;
      const projectId = attributes["pi.project.id"] ?? null;
      const write = pool
        .query(
          `INSERT INTO agent_telemetry_spans (turn_id, project_id, name, duration_ms, status, attributes, error)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [turnId, projectId, options.name, now() - startedAt,
            status?.status ?? "ok", { ...attributes, ...(events.length ? { events } : {}) }, status?.error ?? null],
        )
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`telemetry persist failed (${options.name}): ${message}\n`);
        })
        .finally(() => { pending.delete(write); });
      pending.add(write);
    };

    let result: T | Promise<T>;
    try {
      result = callback(span);
    } catch (error) {
      span.setStatus(errorStatus(error));
      persist();
      throw error;
    }

    return Promise.resolve(result).then(
      (value) => { persist(); return value; },
      (error: unknown) => {
        span.setStatus(errorStatus(error));
        persist();
        throw error;
      },
    );
  }

  async function drain(timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (pending.size > 0 && Date.now() < deadline) {
      await Promise.allSettled([...pending]);
    }
  }

  return { startSpan, drain };
}

function errorStatus(error: unknown): { status: string; error: Record<string, unknown> } {
  if (error instanceof Error) {
    return { status: "error", error: { name: error.name, message: error.message } };
  }
  return { status: "error", error: { name: "Error", message: String(error) } };
}

export function createTeeTelemetry(sinks: TelemetryContext[]): TelemetryContext {
  if (!Array.isArray(sinks) || sinks.length === 0) throw new TypeError("createTeeTelemetry requires at least one sink");
  return {
    startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
      const wrap = (index: number): ((span: TelemetrySpan) => T | Promise<T>) =>
        index >= sinks.length - 1 ? callback : () => sinks[index + 1].startSpan(options, wrap(index + 1));
      return sinks[0].startSpan(options, wrap(0));
    },
  };
}
