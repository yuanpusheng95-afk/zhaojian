import { SessionError, type SessionErrorCode } from '@earendil-works/pi-agent-core';

export function sessionError(code: SessionErrorCode, message: string, cause?: unknown) {
  return new SessionError(code, message, cause as Error | undefined);
}

/** PostgreSQL 唯一约束冲突。调用方据此转成 pi 的 already_exists。 */
export function isUniqueViolation(error: unknown): boolean {
  const pgError = error as { code?: unknown; cause?: { code?: unknown } };
  return pgError.code === '23505' || pgError.cause?.code === '23505';
}
