import http from 'node:http';

import { IdempotencyConflictError, ProjectBusyError } from '../infrastructure/postgres/agent-turn-queue.mjs';
import { handleTurnEvents } from './sse.mjs';

const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

export function createApiServer({ repository, queue, turnViews, logger = console }) {
  if (!repository) throw new TypeError('createApiServer requires repository');
  if (!queue) throw new TypeError('createApiServer requires queue');
  if (!turnViews) throw new TypeError('createApiServer requires turnViews');
  const eventStreamResponses = new Set();
  const server = http.createServer(async (request, response) => {
    try {
      await routeRequest({
        request, response, repository, queue, turnViews, eventStreamResponses,
      });
    } catch (error) {
      writeError(response, error, logger);
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
  request, response, repository, queue, turnViews, eventStreamResponses,
}) {
  const url = new URL(request.url, 'http://localhost');
  const path = url.pathname;

  if (request.method === 'GET' && path === '/health') {
    return writeJson(response, 200, { status: 'ok' });
  }

  if (request.method === 'POST' && path === '/projects') {
    const body = await readJson(request);
    const project = await repository.createProject(body);
    return writeJson(response, 201, project);
  }

  const projectMatch = path.match(/^\/projects\/([^/]+)$/);
  if (request.method === 'GET' && projectMatch) {
    const project = await repository.getProject(decode(projectMatch[1]));
    return writeJson(response, 200, project);
  }

  const generationMatch = path.match(/^\/generations\/([^/]+)$/);
  if (request.method === 'GET' && generationMatch) {
    const generation = await repository.getGeneration(
      decode(generationMatch[1]),
    );
    return writeJson(response, 200, generation);
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
    return writeJson(response, result.replayed ? 200 : 202, result);
  }

  const turnMatch = path.match(/^\/projects\/([^/]+)\/turns\/([^/]+)$/);
  if (request.method === 'GET' && turnMatch) {
    const detail = await turnViews.loadTurnDetail({
      projectId: decode(turnMatch[1]),
      turnId: decode(turnMatch[2]),
    });
    return writeJson(response, 200, detail);
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
    return writeJson(response, 200, { revisionId: revision.id });
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
    });
  }

  throw new HttpError(404, 'NOT_FOUND', 'Route not found');
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

function writeError(response, error, logger) {
  if (response.headersSent) {
    response.destroy();
    return;
  }

  const mapped = mapError(error);
  if (mapped.status === 500) logger.error(error);
  writeJson(response, mapped.status, {
    error: { code: mapped.code, message: mapped.message },
  });
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

function writeJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
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
