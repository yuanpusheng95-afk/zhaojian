import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import nodePath from 'node:path';

import { buildAssetKey, buildAssetUri } from '../infrastructure/storage/asset-storage.mjs';

import { IdempotencyConflictError, ProjectBusyError } from '../infrastructure/postgres/agent-turn-queue.mjs';
import { handleTurnEvents } from './sse.mjs';

const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_UPLOAD_BODY_BYTES = 20 * 1024 * 1024;
const PUBLIC_DIR = nodePath.resolve(process.cwd(), 'public');

export function createApiServer({ repository, queue, turnViews, assetStorage, corsOrigin = '*', logger = console }) {
  if (!repository) throw new TypeError('createApiServer requires repository');
  if (!queue) throw new TypeError('createApiServer requires queue');
  if (!turnViews) throw new TypeError('createApiServer requires turnViews');
  if (!assetStorage) throw new TypeError('createApiServer requires assetStorage');
  const eventStreamResponses = new Set();
  // CORS 头统一注入:SSE(EventSource 不发预检,流响应必须自带)与自定义头
  // Idempotency-Key 都依赖它;所有出口都经 writeJson 或 SSE 的 writeHead
  const cors = {
    'access-control-allow-origin': corsOrigin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Content-Type, Idempotency-Key',
  };
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === 'OPTIONS') {
        response.writeHead(204, cors);
        response.end();
        return;
      }
      await routeRequest({
        request, response, repository, queue, turnViews, assetStorage, eventStreamResponses, cors, logger,
      });
    } catch (error) {
      writeError(response, error, logger, cors);
    }
  });
  server.closeActiveEventStreams = () => {
    for (const response of eventStreamResponses) {
      if (!response.writableEnded) response.destroy();
    }
  };
  return server;
}

async function routeRequest({
  request, response, repository, queue, turnViews, assetStorage, eventStreamResponses, cors, logger,
}) {
  const url = new URL(request.url, 'http://localhost');
  const path = url.pathname;

  if (request.method === 'GET' && (path === '/' || path === '/index.html')) {
    try {
      const html = await readFile(nodePath.join(PUBLIC_DIR, 'index.html'));
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...cors });
      response.end(html);
    } catch {
      writeError(response, new HttpError(404, 'NOT_FOUND', 'index.html not found'), logger);
    }
    return;
  }

  if (request.method === 'GET' && path === '/health') {
    return writeJson(response, 200, { status: 'ok' }, cors);
  }

  if (request.method === 'POST' && path === '/projects') {
    const body = await readJson(request);
    const project = await repository.createProject(body);
    return writeJson(response, 201, project, cors);
  }

  const projectMatch = path.match(/^\/projects\/([^/]+)$/);
  if (request.method === 'GET' && projectMatch) {
    const project = await repository.getProject(decode(projectMatch[1]));
    return writeJson(response, 200, project, cors);
  }

  const generationMatch = path.match(/^\/generations\/([^/]+)$/);
  if (request.method === 'GET' && generationMatch) {
    const generation = await repository.getGeneration(
      decode(generationMatch[1]),
    );
    return writeJson(response, 200, generation, cors);
  }

  // 图片上传:原始字节做请求体,Content-Type 头决定扩展名(§6.2)。
  // 上传先于项目存在,故 key 用 uploads 作用域;POST /projects 时随 anchorAsset 回传
  if (request.method === 'POST' && path === '/uploads') {
    const contentType = (request.headers['content-type'] ?? '').toLowerCase().split(';')[0].trim();
    if (!contentType.startsWith('image/')) {
      throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be image/*');
    }
    const bytes = await readBody(request);
    const assetId = `upload_${randomUUID()}`;
    const key = buildAssetKey({ ownerId: 'dev', projectId: 'uploads', assetId, contentType });
    await assetStorage.put(key, bytes, contentType);
    const asset = await repository.recordAsset({
      assetId,
      uri: buildAssetUri(assetStorage.bucket, key),
      metadata: { contentType },
    });
    return writeJson(response, 201, {
      assetId: asset.id,
      uri: asset.uri,
      metadata: asset.metadata,
    }, cors);
  }

  const messageMatch = path.match(/^\/projects\/([^/]+)\/messages$/);
  if (request.method === 'POST' && messageMatch) {
    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
      throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required');
    }
    const body = await readJson(request);
    if (typeof body.message !== 'string' || body.message.trim() === '') {
      throw new HttpError(400, 'INVALID_MESSAGE', 'message must be a non-empty string');
    }
    const result = await queue.requestTurn({
      projectId: decode(messageMatch[1]),
      userMessage: body.message,
      idempotencyKey,
    });
    return writeJson(response, result.replayed ? 200 : 202, result, cors);
  }

  const turnMatch = path.match(/^\/projects\/([^/]+)\/turns\/([^/]+)$/);
  if (request.method === 'GET' && turnMatch) {
    const detail = await turnViews.loadTurnDetail({
      projectId: decode(turnMatch[1]),
      turnId: decode(turnMatch[2]),
    });
    return writeJson(response, 200, detail, cors);
  }

  const turnSelectionMatch = path.match(
    /^\/projects\/([^/]+)\/turns\/([^/]+)\/selections$/,
  );
  if (request.method === 'POST' && turnSelectionMatch) {
    await turnViews.assertTurnExists({
      projectId: decode(turnSelectionMatch[1]),
      turnId: decode(turnSelectionMatch[2]),
    });
    const body = await readJson(request);
    if (typeof body.generationId !== 'string' || body.generationId.trim() === '' ||
        typeof body.candidateId !== 'string' || body.candidateId.trim() === '') {
      throw new HttpError(400, 'INVALID_SELECTION', 'generationId and candidateId are required');
    }
    const revision = await repository.selectCandidate({
      projectId: decode(turnSelectionMatch[1]),
      generationId: body.generationId,
      candidateId: body.candidateId,
    });
    return writeJson(response, 200, { revisionId: revision.id }, cors);
  }

  const turnEventsMatch = path.match(
    /^\/projects\/([^/]+)\/turns\/([^/]+)\/events$/,
  );
  if (request.method === 'GET' && turnEventsMatch) {
    eventStreamResponses.add(response);
    response.once('close', () => eventStreamResponses.delete(response));
    return handleTurnEvents({
      request,
      response,
      turnViews,
      projectId: decode(turnEventsMatch[1]),
      turnId: decode(turnEventsMatch[2]),
      pollMs: url.searchParams.get('pollMs'),
      cors,
    });
  }

  throw new HttpError(404, 'NOT_FOUND', 'Route not found');
}

async function readBody(request, maxBytes = MAX_UPLOAD_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > maxBytes) {
      throw new HttpError(413, 'REQUEST_TOO_LARGE', `Upload exceeds ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request) {
  let body = '';
  let size = 0;

  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > MAX_REQUEST_BODY_BYTES) {
      throw new HttpError(
        413,
        'REQUEST_TOO_LARGE',
        'Request body exceeds 1 MiB',
      );
    }
    body += chunk;
  }

  if (body.length === 0) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError(
      400,
      'INVALID_JSON',
      'Request body is not valid JSON',
    );
  }
}

function writeError(response, error, logger, cors) {
  if (response.headersSent) {
    response.destroy();
    return;
  }

  const mapped = mapError(error);
  if (mapped.status === 500) logger.error(error);
  writeJson(response, mapped.status, {
    error: { code: mapped.code, message: mapped.message },
  }, cors);
}

function mapError(error) {
  if (error instanceof HttpError) return error;

  if (
    [
      'PROJECT_NOT_FOUND',
      'GENERATION_NOT_FOUND',
      'TURN_NOT_FOUND',
      'REVISION_NOT_FOUND',
      'ASSET_NOT_FOUND',
    ].includes(error.code)
) {
    return new HttpError(404, error.code, error.message);
  }

  if (error.code === 'UNSUPPORTED_MEDIA_TYPE') {
    return new HttpError(415, error.code, error.message);
  }

  if (error.code === '23505') {
    return new HttpError(409, 'RESOURCE_CONFLICT', 'Resource already exists');
  }

  if (
    [
      'REVISION_CONFLICT',
      'CANDIDATE_SELECTION_ERROR',
      'PROJECT_EXISTS',
      'IDEMPOTENCY_CONFLICT',
      'PROJECT_BUSY',
    ].includes(error.code)
  ) {
    return new HttpError(409, error.code, error.message);
  }

  if (
    [
      'INVALID_GENERATION_REQUEST',
      'INVALID_STATE_PATCH',
      'UNSAFE_STATE_PATH',
      'PATCH_CONFLICT',
    ].includes(error.code)
  ) {
    return new HttpError(400, error.code, error.message);
  }

  return new HttpError(500, 'INTERNAL_ERROR', 'Internal server error');
}

function writeJson(response, status, body, cors) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...(cors ?? {}),
  });
  response.end(JSON.stringify(body));
}

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, 'INVALID_PATH', 'Path contains invalid encoding');
  }
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
