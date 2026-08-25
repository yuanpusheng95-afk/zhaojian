import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Pool } from "pg";

import { ErrorCode } from "../../domain/errors.js";
import { HttpError } from "../../api/http-error.js";
import { hashPassword, verifyPassword } from "./password.js";
import { AuthError, type JwtSessionStore } from "./jwt-session.js";
import { createUserRepository, type UserRepository } from "./user-repository.js";

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  displayName: z.string().max(64).optional(),
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export interface AuthDeps {
  pool: Pool;
  sessionStore: JwtSessionStore;
}

/**
 * /auth 路由：注册、登录、登出、当前用户。
 * 成功后设置 HttpOnly cookie（auth_token），前端无需手动管 token。
 */
export function createAuthRoutes({ pool, sessionStore }: AuthDeps) {
  const users: UserRepository = createUserRepository({ pool });
  const app = new Hono();

  app.post("/register", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = RegisterSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(400, ErrorCode.INVALID_USER_ID, "Valid email and password (8+ chars) required");
    }
    const { email, password, displayName } = parsed.data;

    const existing = await users.findByEmail(email);
    if (existing) throw new HttpError(409, "EMAIL_TAKEN", "An account with this email already exists");

    try {
      const user = await users.create({ email, passwordHash: await hashPassword(password), displayName });
      const session = await sessionStore.issue(user.id);
      setAuthCookie(c, session.token, session.expiresInSeconds);
      return c.json(publicUser(user), 201);
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new HttpError(409, "EMAIL_TAKEN", "An account with this email already exists");
      }
      throw error;
    }
  });

  app.post("/login", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = LoginSchema.safeParse(body);
    if (!parsed.success) throw new HttpError(400, ErrorCode.INVALID_USER_ID, "Email and password required");

    const user = await users.findByEmail(parsed.data.email);
    // 统一错误信息：不向探测者泄露邮箱是否存在
    if (!user || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
      throw new HttpError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
    }
    const session = await sessionStore.issue(user.id);
    setAuthCookie(c, session.token, session.expiresInSeconds);
    return c.json(publicUser(user));
  });

  app.post("/logout", async (c) => {
    const token = readAuthCookie(c);
    if (token) {
      try {
        const { sessionId } = await sessionStore.verify(token);
        await sessionStore.revoke(sessionId);
      } catch {
        // token 已无效——登出目标已达成，不报错
      }
    }
    c.header("Set-Cookie", clearAuthCookie());
    return c.json({ ok: true });
  });

  app.get("/me", async (c) => {
    const token = readAuthCookie(c);
    if (!token) throw new HttpError(401, "UNAUTHENTICATED", "Sign in required");
    try {
      const { userId } = await sessionStore.verify(token);
      const user = await users.findById(userId);
      if (!user) throw new Error("user vanished");
      return c.json(publicUser(user));
    } catch (error) {
      if (error instanceof AuthError) throw new HttpError(401, "UNAUTHENTICATED", error.message);
      throw error;
    }
  });

  return app;
}

function publicUser(user: { id: string; email: string; displayName: string }) {
  return { id: user.id, email: user.email, displayName: user.displayName };
}

const COOKIE_NAME = "auth_token";

function setAuthCookie(c: Context, token: string, maxAgeSeconds: number): void {
  c.header("Set-Cookie",
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`);
}

function readAuthCookie(c: { req: { header(name: string): string | undefined } }): string | null {
  const header = c.req.header("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE_NAME) return rest.join("=");
  }
  return null;
}

function clearAuthCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
