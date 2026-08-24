const TERMINAL_STATUSES = new Set(['completed', 'failed', 'aborted']);
const CONTROLLED_ERROR_CODES = new Set([
  'TURN_NOT_FOUND',
  'REVISION_NOT_FOUND',
  'ASSET_NOT_FOUND',
  'INVALID_ASSET_URI',
]);
const MIN_POLL_MS = 250;
const HEARTBEAT_MS = 15_000;

export function parsePollMs(value?: string | number | null): number {
  const parsed = Number(value ?? 1000);
  if (!Number.isFinite(parsed) || parsed < MIN_POLL_MS) return MIN_POLL_MS;
  return parsed;
}

export async function handleTurnEvents({
  request,
  response,
  turnViews,
  projectId,
  turnId,
  pollMs,
  cors = {},
}: {
  request: import('node:http').IncomingMessage;
  response: import('node:http').ServerResponse;
  turnViews: any;
  projectId: string;
  turnId: string;
  pollMs?: string | null;
  cors?: Record<string, string>;
}) {
  const intervalMs = parsePollMs(pollMs);
  if (!request || !response || typeof request.on !== 'function') {
    throw new TypeError('handleTurnEvents requires HTTP streams');
  }
  // EventSource 是跨域 GET,不带预检——流响应本身必须带 allow-origin
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    ...cors,
  });
  response.write(': ping\n\n');

  let closed = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeatTimer);
    clearTimeout(pollTimer);
  }

  request.on('close', cleanup);
  response.once?.('close', cleanup);

  function send(event: string, data: unknown) {
    if (closed) return false;
    const ok = response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (!ok) {
      response.destroy();
      cleanup();
      return false;
    }
    return true;
  }

  heartbeatTimer = setInterval(() => {
    if (closed || !response.write(': ping\n\n')) cleanup();
  }, HEARTBEAT_MS);

  async function loop(lastFingerprint?: string | null) {
    if (closed) return;
    const { changed, fingerprint } = await turnViews.turnChangedSince({
      projectId, turnId, lastFingerprint,
    });
    if (!changed) {
      pollTimer = setTimeout(() => {
        loop(fingerprint).catch(fail);
      }, intervalMs);
      return;
    }
    const detail = await turnViews.loadTurnDetail({ projectId, turnId });
    if (!send('turn', detail)) return;
    if (TERMINAL_STATUSES.has(detail.status)) {
      send('done', {});
      response.end();
      cleanup();
      return;
    }
    pollTimer = setTimeout(() => {
      loop(fingerprint).catch(fail);
    }, intervalMs);
  }

  async function fail(error: unknown) {
    if (closed) return;
    send('error', toErrorPayload(error));
    cleanup();
    response.end();
  }

  try {
    await loop(null);
  } catch (error) {
    await fail(error);
  }
}

function toErrorPayload(error: any) {
  if (CONTROLLED_ERROR_CODES.has(error?.code)) {
    return { code: error.code, message: error.message };
  }
  return { code: 'INTERNAL_ERROR', message: 'Turn event stream failed' };
}
