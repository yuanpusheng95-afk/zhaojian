import { ErrorCode } from "../domain/errors.js";
import type { TurnViews } from "./turn-views.js";

export const TERMINAL_TURN_STATUSES = new Set(["completed", "failed", "aborted"]);

const CONTROLLED_ERROR_CODES = new Set<string>([
  ErrorCode.TURN_NOT_FOUND,
  ErrorCode.REVISION_NOT_FOUND,
  ErrorCode.ASSET_NOT_FOUND,
  ErrorCode.INVALID_ASSET_URI,
]);
const MIN_POLL_MS = 250;

export function parsePollMs(value?: string | number | null): number {
  const parsed = Number(value ?? 1000);
  if (!Number.isFinite(parsed) || parsed < MIN_POLL_MS) return MIN_POLL_MS;
  return parsed;
}

export type TurnStreamEvent =
  | { type: "snapshot"; view: Record<string, unknown> }
  | { type: "done" }
  | { type: "error"; payload: { code: string; message: string } };

export function toErrorPayload(error: any): { code: string; message: string } {
  if (CONTROLLED_ERROR_CODES.has(error?.code)) {
    return { code: error.code, message: error.message };
  }
  return { code: "INTERNAL_ERROR", message: "Turn event stream failed" };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish);
  });
}

export interface TurnEventSource {
  next(lastFingerprint: string | null | undefined): Promise<{
    changed: boolean;
    fingerprint: string | null;
    view?: Record<string, unknown>;
  }>;
}

/** 轮询数据库指纹的事件源：主干实现，不依赖任何外部通知。 */
class PollingEventSource implements TurnEventSource {
  constructor(
    private readonly views: Pick<TurnViews, "turnChangedSince" | "loadTurnDetail">,
    private readonly projectId: string,
    private readonly turnId: string,
  ) {}

  async next(lastFingerprint: string | null | undefined) {
    const changed = await this.views.turnChangedSince({ projectId: this.projectId, turnId: this.turnId, lastFingerprint });
    let view: Record<string, unknown> | undefined;
    if (changed.changed) {
      view = await this.views.loadTurnDetail({ projectId: this.projectId, turnId: this.turnId }) as Record<string, unknown>;
    }
    return { changed: changed.changed, fingerprint: changed.fingerprint, view };
  }
}

/** Redis stream 加速事件源：有通知立即返回，无通知等 blockMs。 */
class RedisEventSource implements TurnEventSource {
  constructor(
    private readonly inner: PollingEventSource,
    private readonly consumer: { readTurnEvent(turnId: string, lastId: string, blockMs: number): Promise<{ id: string } | null> },
    private readonly turnId: string,
  ) {}

  async next(lastFingerprint: string | null | undefined) {
    // 先查一次数据库指纹，保证不丢掉 Redis 通知之前的变化
    const result = await this.inner.next(lastFingerprint);
    if (result.view && TERMINAL_TURN_STATUSES.has((result.view.status as string) ?? "")) return result;

    const notification = await this.consumer.readTurnEvent(this.turnId, this.lastEventId, 250);
    if (notification) this.lastEventId = notification.id;
    return { ...result, fingerprint: result.fingerprint, view: result.view };
  }

  private lastEventId = "0";
}

/** Redis 失败时永久降级为纯轮询的装饰器。 */
class FallbackEventSource implements TurnEventSource {
  constructor(
    private readonly primary: TurnEventSource,
    private readonly fallback: TurnEventSource,
    private readonly onFallback: (error: unknown) => void,
  ) {}

  async next(lastFingerprint: string | null | undefined) {
    try {
      return await this.primary.next(lastFingerprint);
    } catch (error) {
      this.onFallback(error);
      return this.fallback.next(lastFingerprint);
    }
  }
}

export interface TurnEventStreamOptions {
  turnViews: Pick<TurnViews, "turnChangedSince" | "loadTurnDetail">;
  eventConsumer?: { readTurnEvent(turnId: string, lastId: string, blockMs: number): Promise<{ id: string; event: unknown } | null> } | null;
  projectId: string;
  turnId: string;
  pollMs: number;
  signal: AbortSignal;
  onFallback?: (error: unknown) => void;
}

/**
 * 组合事件源并产出 SSE 帧。
 * 有 Redis → Fallback(Redis(Polling))；没有 → 纯 Polling。
 * 外层循环只关心"要不要发 snapshot / 结束"，不再感知数据从哪来。
 */
export async function* createTurnEventStream({
  turnViews, eventConsumer = null, projectId, turnId, pollMs, signal, onFallback = () => {},
}: TurnEventStreamOptions): AsyncGenerator<TurnStreamEvent> {
  const polling = new PollingEventSource(turnViews, projectId, turnId);
  const source: TurnEventSource = eventConsumer
    ? new FallbackEventSource(
        new RedisEventSource(polling, eventConsumer, turnId),
        polling,
        onFallback,
      )
    : polling;

  let lastFingerprint: string | null | undefined;
  while (!signal.aborted) {
    try {
      const result = await source.next(lastFingerprint);
      lastFingerprint = result.fingerprint;
      if (result.view) {
        yield { type: "snapshot", view: result.view };
        if (TERMINAL_TURN_STATUSES.has((result.view.status as string) ?? "")) {
          yield { type: "done" };
          return;
        }
      }
      if (!eventConsumer || !lastFingerprint) await sleep(pollMs, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      yield { type: "error", payload: toErrorPayload(error) };
      return;
    }
  }
}
