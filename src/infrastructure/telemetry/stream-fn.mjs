/**
 * StreamFn 的仪器化包装：每个 LLM 请求出一个 pi.ai.request span(计到流完成,
 * 经 EventStream.result()),对瞬时错误(限流/超时/5xx/连接类)重试。
 *
 * pi 的 openai-completions 实现不消费 maxRetries(实测仅 azure/google 路径消费),
 * 重试只能在这里做。安全的前提是本包装延迟交付流:重试时丢弃旧流、只交付成功那个,
 * 不会向 Agent 双重发送事件。延迟交付对 worker 无影响(轮内无增量消费)。
 *
 * 从 main.mjs 拆出为独立模块是为了可测:重试与 span 行为在此单测,
 * main 只做接线。
 */
export const RETRYABLE_STREAM_ERROR = /429|rate.?limit|timeout|econn|reset|5\d{2}|temporar|overload/i;

export function instrumentStreamFn({
  telemetry,
  streamFn,
  attributes = {},
  maxRetries = 2,
  backoffBaseMs = 1000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (!telemetry) throw new TypeError('instrumentStreamFn requires telemetry');
  if (typeof streamFn !== 'function') throw new TypeError('instrumentStreamFn requires a streamFn');

  return (model, context, options) =>
    telemetry.startSpan(
      {
        name: 'pi.ai.request',
        attributes: {
          'pi.model.provider': model.provider,
          'pi.model.id': model.id,
          ...attributes,
        },
      },
      async (span) => {
        for (let attempt = 1; ; attempt += 1) {
          const stream = await streamFn(model, context, options);
          const message = await stream.result();
          const retryable = message.stopReason === 'error'
            && RETRYABLE_STREAM_ERROR.test(message.errorMessage ?? '');
          if (!retryable || attempt > maxRetries) {
            span.setAttributes({ 'pi.ai.stop_reason': message.stopReason ?? '', 'pi.ai.attempt': attempt });
            if (message.stopReason === 'error') {
              span.setStatus({ status: 'error', error: { message: message.errorMessage ?? 'stream error' } });
            }
            return stream;
          }
          span.addEvent('retry', { attempt, reason: String(message.errorMessage).slice(0, 120) });
          await sleep(backoffBaseMs * 2 ** (attempt - 1));
        }
      },
    );
}
