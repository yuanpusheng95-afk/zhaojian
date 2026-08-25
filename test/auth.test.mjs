import assert from 'node:assert/strict';
import { describe, test } from 'bun:test';

import { createJwtSessionStore, AuthError } from '../src/infrastructure/auth/jwt-session.js';
import { hashPassword, verifyPassword } from '../src/infrastructure/auth/password.js';
import { createUserRepository } from '../src/infrastructure/auth/user-repository.js';

/** 最小 Redis 替身：只实现 auth 用到的三个命令。 */
function fakeRedis() {
  const store = new Map();
  const timers = new Map();
  return {
    async set(key, value, _ex, ttl) {
      store.set(key, value);
      if (timers.has(key)) clearTimeout(timers.get(key));
      // 不真的等 TTL，只记录
      store.ttl = ttl;
    },
    async get(key) {
      return store.get(key) ?? null;
    },
    async del(key) {
      store.delete(key);
    },
    _store: store,
  };
}

describe('password hashing', () => {
  test('hash and verify round-trip', async () => {
    const hash = await hashPassword('secret-password');
    assert.ok(hash.startsWith('$2'));
    assert.equal(await verifyPassword('secret-password', hash), true);
    assert.equal(await verifyPassword('wrong-password', hash), false);
  });
});

describe('jwt session store', () => {
  const SECRET = 'unit-test-secret-0123456789abcdef'; // 32 chars

  function createStore() {
    const redis = fakeRedis();
    const store = createJwtSessionStore({ jwtSecret: SECRET, redis, ttlSeconds: 3600 });
    return { store, redis };
  }

  test('issue then verify returns the same userId', async () => {
    const { store } = createStore();
    const session = await store.issue('user_1');
    assert.match(session.token, /^eyJ/);
    const verified = await store.verify(session.token);
    assert.equal(verified.userId, 'user_1');
    assert.equal(verified.sessionId, session.sessionId);
  });

  test('revoke makes the token immediately unusable', async () => {
    const { store } = createStore();
    const session = await store.issue('user_1');
    await store.revoke(session.sessionId);
    await assert.rejects(() => store.verify(session.token), AuthError);
  });

  test('tampered token is rejected', async () => {
    const { store } = createStore();
    const session = await store.issue('user_1');
    const forged = session.token.slice(0, -3) + 'xxx';
    await assert.rejects(() => store.verify(forged), AuthError);
  });

  test('garbage token is rejected', async () => {
    const { store } = createStore();
    await assert.rejects(() => store.verify('not-a-jwt'), AuthError);
  });

  test('short secret is rejected at construction', () => {
    assert.throws(
      () => createJwtSessionStore({ jwtSecret: 'too-short', redis: fakeRedis() }),
      /at least 32/,
    );
  });

  test('session survives other keys being deleted', async () => {
    const { store, redis } = createStore();
    await store.issue('user_1');
    const session2 = await store.issue('user_2');
    await store.revoke('nonexistent');
    const verified = await store.verify(session2.token);
    assert.equal(verified.userId, 'user_2');
    void redis;
  });
});

describe('user repository', () => {
  function fakePoolWithUsers() {
    const rows = new Map();
    let callCount = 0;
    return {
      async query(sql, params) {
        callCount += 1;
        if (sql.includes('INSERT INTO users')) {
          const [id, email] = params;
          if ([...rows.values()].some((r) => r.email === email)) {
            const err = new Error('duplicate key');
            err.code = '23505';
            throw err;
          }
          const row = { id, email, passwordHash: params[2], displayName: params[3] };
          rows.set(id, row);
          return { rows: [row] };
        }
        if (sql.includes('WHERE email')) {
          const found = [...rows.values()].find((r) => r.email === params[0]);
          return { rows: found ? [found] : [] };
        }
        if (sql.includes('WHERE id')) {
          const row = rows.get(params[0]);
          return { rows: row ? [row] : [] };
        }
        throw new Error(`unexpected sql: ${sql}`);
      },
      _callCount: () => callCount,
    };
  }

  test('create and findByEmail round-trip; email lowercased', async () => {
    const repo = createUserRepository({ pool: fakePoolWithUsers() });
    const created = await repo.create({ email: 'Alice@Example.COM', passwordHash: 'h' });
    assert.equal(created.email, 'alice@example.com');
    const found = await repo.findByEmail('ALICE@example.com');
    assert.equal(found.id, created.id);
  });

  test('duplicate email surfaces as 23505', async () => {
    const repo = createUserRepository({ pool: fakePoolWithUsers() });
    await repo.create({ email: 'a@b.com', passwordHash: 'h' });
    await assert.rejects(
      () => repo.create({ email: 'a@b.com', passwordHash: 'h' }),
      (error) => error.code === '23505',
    );
  });

  test('findById misses cleanly', async () => {
    const repo = createUserRepository({ pool: fakePoolWithUsers() });
    assert.equal(await repo.findById('missing'), null);
  });
});
