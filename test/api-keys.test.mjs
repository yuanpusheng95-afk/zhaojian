import assert from 'node:assert/strict';
import { describe, test } from 'bun:test';

import { createApiKeyStore, generateApiKey, API_KEY_PREFIX } from '../src/infrastructure/auth/api-keys.js';

/** 内存 api_keys 表替身，模拟 SQL 行为（含 revoked_at / last_used_at）。 */
function fakePool() {
  const rows = new Map();
  let seq = 0;
  return {
    async query(sql, params) {
      if (sql.includes('INSERT INTO api_keys')) {
        const [id, userId, keyHash, name] = params;
        if ([...rows.values()].some((r) => r.keyHash === keyHash)) {
          const err = new Error('duplicate');
          err.code = '23505';
          throw err;
        }
        const row = { id, userId, keyHash, name, lastUsedAt: null, revokedAt: null, createdAt: new Date() };
        rows.set(id, row);
        return { rows: [{ id, userId, name, createdAt: row.createdAt }], rowCount: 1 };
      }
      if (sql.includes('SET last_used_at')) {
        const found = [...rows.values()].find((r) => r.keyHash === params[0] && !r.revokedAt);
        if (!found) return { rows: [], rowCount: 0 };
        found.lastUsedAt = new Date();
        return { rows: [{ user_id: found.userId }], rowCount: 1 };
      }
      if (sql.includes('ORDER BY created_at')) {
        const list = [...rows.values()].filter((r) => r.userId === params[0]);
        return {
          rows: list.map(({ id, userId, name, lastUsedAt, revokedAt, createdAt }) => ({
            id, userId, name, lastUsedAt, revokedAt, createdAt,
          })),
        };
      }
      if (sql.includes('SET revoked_at')) {
        const [keyId, userId] = params;
        const row = rows.get(keyId);
        if (!row || row.userId !== userId || row.revokedAt) return { rowCount: 0 };
        row.revokedAt = new Date();
        return { rowCount: 1 };
      }
      throw new Error(`unexpected sql: ${sql.slice(0, 60)}`);
    },
    _rows: rows,
  };
}

describe('api keys', () => {
  test('generated keys have the zj_ prefix and high entropy', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    assert.ok(a.startsWith(API_KEY_PREFIX));
    assert.ok(a.length > 40);
    assert.notEqual(a, b);
  });

  test('issue → authenticate round-trip returns the owner', async () => {
    const store = createApiKeyStore({ pool: fakePool() });
    const { plaintext } = await store.issue('user_1', 'laptop');
    const userId = await store.authenticate(plaintext);
    assert.equal(userId, 'user_1');
  });

  test('authenticate rejects garbage and wrong prefix', async () => {
    const store = createApiKeyStore({ pool: fakePool() });
    await store.issue('user_1', 'k');
    assert.equal(await store.authenticate('not-a-key'), null);
    assert.equal(await store.authenticate('sk_something'), null);
    // 正确前缀但库里没有
    assert.equal(await store.authenticate(`${API_KEY_PREFIX}${'x'.repeat(43)}`), null);
  });

  test('revoked key stops working immediately', async () => {
    const store = createApiKeyStore({ pool: fakePool() });
    const { record, plaintext } = await store.issue('user_1', 'k');
    assert.equal(await store.authenticate(plaintext), 'user_1');

    const revoked = await store.revoke('user_1', record.id);
    assert.equal(revoked, true);
    assert.equal(await store.authenticate(plaintext), null);

    // 再吊销一次返回 false（幂等）
    assert.equal(await store.revoke('user_1', record.id), false);
  });

  test('cannot revoke someone else\'s key', async () => {
    const store = createApiKeyStore({ pool: fakePool() });
    const { record, plaintext } = await store.issue('user_1', 'k');
    const stolen = await store.revoke('user_2', record.id);
    assert.equal(stolen, false);
    assert.equal(await store.authenticate(plaintext), 'user_1');
  });

  test('list only shows own keys, never hashes or plaintexts', async () => {
    const store = createApiKeyStore({ pool: fakePool() });
    const { plaintext } = await store.issue('user_1', 'mine');
    await store.issue('user_2', 'theirs');

    const list = await store.list('user_1');
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'mine');
    const json = JSON.stringify(list);
    assert.ok(!json.includes(plaintext));
    assert.ok(!json.includes('keyHash'));
  });
});
