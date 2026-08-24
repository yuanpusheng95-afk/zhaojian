import { SessionError } from '@earendil-works/pi-agent-core';

export function sessionError(code: any, message: string, cause?: unknown) {
  return new SessionError(code, message, cause as Error | undefined);
}

/** PostgreSQL 唯一约束冲突。调用方据此转成 pi 的 already_exists。 */
export function isUniqueViolation(error: unknown): boolean {
  return (error as any)?.code === '23505';
}
