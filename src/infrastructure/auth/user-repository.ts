import type { Pool } from "pg";

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string;
}

/** users 表访问。email 唯一约束冲突由调用方捕获（23505）。 */
export function createUserRepository({ pool }: { pool: Pool }) {
  async function create({ email, passwordHash, displayName = "" }: {
    email: string; passwordHash: string; displayName?: string;
  }): Promise<UserRecord> {
    const id = `user_${crypto.randomUUID()}`;
    const result = await pool.query(
      `INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, $3, $4)
       RETURNING id, email, password_hash AS "passwordHash", display_name AS "displayName"`,
      [id, email.toLowerCase(), passwordHash, displayName],
    );
    return result.rows[0];
  }

  async function findByEmail(email: string): Promise<UserRecord | null> {
    const result = await pool.query(
      `SELECT id, email, password_hash AS "passwordHash", display_name AS "displayName"
       FROM users WHERE email = $1`,
      [email.toLowerCase()],
    );
    return result.rows[0] ?? null;
  }

  async function findById(userId: string): Promise<UserRecord | null> {
    const result = await pool.query(
      `SELECT id, email, password_hash AS "passwordHash", display_name AS "displayName"
       FROM users WHERE id = $1`,
      [userId],
    );
    return result.rows[0] ?? null;
  }

  return { create, findByEmail, findById };
}

export type UserRepository = ReturnType<typeof createUserRepository>;
