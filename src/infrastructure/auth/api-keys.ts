import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";

/**
 * API key 认证：机器凭证，无会话语义。
 * - 明文 key 只在创建时返回一次（zj_<43 字符 base64url>，256 bit 熵）；
 * - 库里只存 SHA-256，拖库不可逆；
 * - 撤销 = UPDATE revoked_at，立即生效；
 * - 验证 = 哈希查表 + revoked_at 为空，不需要 Redis 或签名。
 */

export const API_KEY_PREFIX = "zj_";
const KEY_BYTES = 32;

export interface ApiKeyRecord {
  id: string;
  userId: string;
  name: string;
  createdAt: Date;
}

interface ApiKeyRow {
  id: string;
  userId: string;
  name: string;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

function hashKey(plain: string): string {
  return createHash("sha256").update(plain).digest("hex");
}

export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(KEY_BYTES).toString("base64url")}`;
}

export function createApiKeyStore({ pool }: { pool: Pool }) {
  async function issue(userId: string, name: string): Promise<{ record: ApiKeyRecord; plaintext: string }> {
    const plaintext = generateApiKey();
    const id = `key_${crypto.randomUUID()}`;
    const result = await pool.query(
      `INSERT INTO api_keys (id, user_id, key_hash, name) VALUES ($1, $2, $3, $4)
       RETURNING id, user_id AS "userId", name, created_at AS "createdAt"`,
      [id, userId, hashKey(plaintext), name],
    );
    return { record: result.rows[0], plaintext };
  }

  /** 明文 key → userId。key 无效、已吊销均返回 null；命中则顺带更新 last_used_at。 */
  async function authenticate(plaintext: string): Promise<string | null> {
    if (!plaintext.startsWith(API_KEY_PREFIX)) return null;
    const result = await pool.query(
      `UPDATE api_keys SET last_used_at = now()
       WHERE key_hash = $1 AND revoked_at IS NULL
       RETURNING user_id`,
      [hashKey(plaintext)],
    );
    return result.rows[0]?.user_id ?? null;
  }

  async function list(userId: string): Promise<Array<ApiKeyRecord & { lastUsedAt: Date | null; revokedAt: Date | null }>> {
    const result = await pool.query(
      `SELECT id, user_id AS "userId", name, last_used_at AS "lastUsedAt",
              revoked_at AS "revokedAt", created_at AS "createdAt"
       FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
    return result.rows;
  }

  async function revoke(userId: string, keyId: string): Promise<boolean> {
    const result = await pool.query(
      `UPDATE api_keys SET revoked_at = now()
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [keyId, userId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  return { issue, authenticate, list, revoke };
}

export type ApiKeyStore = ReturnType<typeof createApiKeyStore>;
