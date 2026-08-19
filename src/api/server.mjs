import http from 'node:http';

const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

export function createApiServer({ repository, logger = console }) {
  return http.createServer(async (request, response) => {
    try {
      await routeRequest({ request, response, repository });
    } catch (error) {
      writeError(response, error, logger);
    }
  });
}

async function routeRequest({ request, response, repository }) {
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

  const generationRequestMatch = path.match(
    /^\/projects\/([^/]+)\/generations$/,
  );
  if (request.method === 'POST' && generationRequestMatch) {
    const body = await readJson(request);
    const generation = await repository.requestGeneration({
      projectId: decode(generationRequestMatch[1]),
      baseRevisionId: body.baseRevisionId,
      operation: body.operation,
      patch: body.patch,
      idempotencyKey: request.headers['idempotency-key'],
    });
    return writeJson(response, 202, generation);
  }

  const generationMatch = path.match(/^\/generations\/([^/]+)$/);
  if (request.method === 'GET' && generationMatch) {
    const generation = await repository.getGeneration(
      decode(generationMatch[1]),
    );
    return writeJson(response, 200, generation);
  }

  const selectionMatch = path.match(
    /^\/projects\/([^/]+)\/generations\/([^/]+)\/selections$/,
  );
  if (request.method === 'POST' && selectionMatch) {
    const body = await readJson(request);
    const revision = await repository.selectCandidate({
      projectId: decode(selectionMatch[1]),
      generationId: decode(selectionMatch[2]),
      candidateId: body.candidateId,
    });
    return writeJson(response, 201, revision);
  }

  throw new HttpError(404, 'NOT_FOUND', 'Route not found');
}

async function readJson(request) {
  let body = '';
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
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
    ['PROJECT_NOT_FOUND', 'GENERATION_NOT_FOUND', 'REVISION_NOT_FOUND'].includes(
      error.code,
    )
  ) {
    return new HttpError(404, error.code, error.message);
  }

  if (error.code === '23505') {
    return new HttpError(409, 'RESOURCE_CONFLICT', 'Resource already exists');
  }

  if (
    [
      'REVISION_CONFLICT',
      'IDEMPOTENCY_CONFLICT',
      'PROJECT_BUSY',
      'CANDIDATE_SELECTION_ERROR',
      'INVALID_GENERATION_TRANSITION',
      'PROJECT_EXISTS',
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
