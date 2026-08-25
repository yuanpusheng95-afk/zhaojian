import { SignJWT, jwtVerify } from "jose";
import type Redis from "ioredis";

/**
 * JWT + Redis 混合会话：
 * - JWT 携带 userId，无状态验证身份；
 * - Redis 存 session id → userId 映射并设 TTL，登出即删 key，
 *   验证时必须同时通过 JWT 校验和 Redis 存在性检查——撤销立即生效。
 */

const SESSION_TTL_SECONDS = 7 * 24 * 3600;
const SESSION_KEY_PREFIX = "auth:session:";

export interface AuthSession {
  userId: string;
  sessionId: string;
  token: string;
  expiresInSeconds: number;
}

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

function sessionKey(sessionId: string): string {
  return `${SESSION_KEY_PREFIX}${sessionId}`;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export interface JwtSessionStoreOptions {
  jwtSecret: string;
  redis: Redis;
  /** 测试注入用 */
  ttlSeconds?: number;
}

export function createJwtSessionStore({ jwtSecret, redis, ttlSeconds = SESSION_TTL_SECONDS }: JwtSessionStoreOptions) {
  if (!jwtSecret || jwtSecret.length < 32) {
    throw new TypeError("jwtSecret must be at least 32 characters");
  }
  const key = secretKey(jwtSecret);

  async function issue(userId: string): Promise<AuthSession> {
    const sessionId = crypto.randomUUID();
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(userId)
      .setJti(sessionId)
      .setIssuedAt()
      .setExpirationTime(`${ttlSeconds}s`)
      .sign(key);
    await redis.set(sessionKey(sessionId), userId, "EX", ttlSeconds);
    return { userId, sessionId, token, expiresInSeconds: ttlSeconds };
  }

  /** 返回 userId；JWT 无效或会话已被撤销（Redis 无 key）时抛 AuthError。 */
  async function verify(token: string): Promise<{ userId: string; sessionId: string }> {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, key));
    } catch {
      throw new AuthError("Invalid or expired token");
    }
    const sessionId = payload.jti;
    const userId = payload.sub;
    if (!sessionId || !userId) throw new AuthError("Malformed token");

    const stored = await redis.get(sessionKey(sessionId));
    if (stored !== userId) throw new AuthError("Session revoked or expired");
    return { userId, sessionId };
  }

  async function revoke(sessionId: string): Promise<void> {
    await redis.del(sessionKey(sessionId));
  }

  return { issue, verify, revoke, ttlSeconds };
}

export type JwtSessionStore = ReturnType<typeof createJwtSessionStore>;
