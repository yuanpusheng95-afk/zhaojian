import { SessionError } from '@earendil-works/pi-agent-core';

export function sessionError(code, message, cause) {
  return new SessionError(code, message, cause);
}

/** PostgreSQL 唯一约束冲突。调用方据此转成 pi 的 already_exists。 */
export function isUniqueViolation(error) {
  return error?.code === '23505';
}
