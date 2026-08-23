/**
 * 与 stdout-telemetry 同契约(startSpan 回调式)的 PostgreSQL 落库适配器。
 * stdout 管实时观察,这里管历史留存与聚合查询(§16 成本统计的地基)。
 *
 * 写入是 fire-and-forget:telemetry 故障绝不能打断业务轮次,
 * 插入失败只往 stderr 记一行。turn_id / project_id 从 span attributes 提取
 * (pi.turn.id / pi.project.id),其余 attributes 原样进 jsonb。
 */
export function createPgTelemetry({ pool, now = () => Date.now() } = {}) {
  if (!pool) throw new TypeError('createPgTelemetry requires a pg pool');

  const pending = new Set();

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

    const persist = () => {
      const turnId = attributes['pi.turn.id'] ?? null;
      const projectId = attributes['pi.project.id'] ?? null;
      const write = pool
        .query(
          `INSERT INTO agent_telemetry_spans
            (turn_id, project_id, name, duration_ms, status, attributes, error)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            turnId,
            projectId,
            options.name,
            now() - startedAt,
            status?.status ?? 'ok',
            { ...attributes, ...(events.length ? { events } : {}) },
            status?.error ?? null,
          ],
        )
        .catch((error) => {
          process.stderr.write(
            `telemetry persist failed (${options.name}): ${error?.message ?? error}\n`,
          );
        })
        .finally(() => {
          pending.delete(write);
        });
      pending.add(write);
    };

    let result;
    try {
      result = callback(span);
    } catch (error) {
      span.setStatus({
        status: 'error',
        error: { name: error?.name ?? 'Error', message: error?.message ?? String(error) },
      });
      persist();
      throw error;
    }

    return Promise.resolve(result).then(
      (value) => {
        persist();
        return value;
      },
      (error) => {
        span.setStatus({
          status: 'error',
          error: { name: error?.name ?? 'Error', message: error?.message ?? String(error) },
        });
        persist();
        throw error;
      },
    );
  }

  /**
   * 等待在途的 span 写入落定(带超时上限)。pool.end() 会拒绝仍在队列里的查询,
   * 优雅关闭前先 drain,避免丢最后几条 span。
   */
  async function drain(timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs;
    while (pending.size > 0 && Date.now() < deadline) {
      await Promise.allSettled([...pending]);
    }
  }

  return { startSpan, drain };
}

/** 多路分发:回调只执行一次,每个 sink 各自计时、各自发射。 */
export function createTeeTelemetry(sinks) {
  if (!Array.isArray(sinks) || sinks.length === 0) {
    throw new TypeError('createTeeTelemetry requires at least one sink');
  }
  return {
    startSpan(options, callback) {
      const wrap = (index) => (index >= sinks.length - 1
        ? callback
        : () => sinks[index + 1].startSpan(options, wrap(index + 1)));
      return sinks[0].startSpan(options, wrap(0));
    },
  };
}
