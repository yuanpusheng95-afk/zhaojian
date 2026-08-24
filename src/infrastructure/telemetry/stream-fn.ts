import type { TelemetryContext } from "./stdout-telemetry.js";

export const RETRYABLE_STREAM_ERROR = /429|rate.?limit|timeout|econn|reset|5\d{2}|temporar|overload/i;

export function instrumentStreamFn({
  telemetry,
  streamFn,
  attributes = {},
  maxRetries = 2,
  backoffBaseMs = 1000,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}: {
  telemetry: TelemetryContext;
  streamFn: (...args: any[]) => Promise<any>;
  attributes?: Record<string, unknown>;
  maxRetries?: number;
  backoffBaseMs?: number;
  sleep?: (ms: number) => Promise<void>;
}) {
  if (!telemetry) throw new TypeError("instrumentStreamFn requires telemetry");
  if (typeof streamFn !== "function") throw new TypeError("instrumentStreamFn requires a streamFn");

  return (model: any, context: any, options: any): Promise<any> =>
    telemetry.startSpan(
      {
        name: "pi.ai.request",
        attributes: { "pi.model.provider": model.provider, "pi.model.id": model.id, ...attributes },
      },
      async (span: any) => {
        for (let attempt = 1; ; attempt += 1) {
          const stream = await streamFn(model, context, options);
          const message = await stream.result();
          const retryable = message.stopReason === "error"
            && RETRYABLE_STREAM_ERROR.test(message.errorMessage ?? "");
          if (!retryable || attempt > maxRetries) {
            span.setAttributes({ "pi.ai.stop_reason": message.stopReason ?? "", "pi.ai.attempt": attempt });
            if (message.stopReason === "error") {
              span.setStatus({ status: "error", error: { message: message.errorMessage ?? "stream error" } });
            }
            return stream;
          }
          span.addEvent("retry", { attempt, reason: String(message.errorMessage).slice(0, 120) });
          await sleep(backoffBaseMs * 2 ** (attempt - 1));
        }
      },
    );
}
