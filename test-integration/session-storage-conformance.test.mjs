import { describe, expect, test } from 'bun:test';

import pg from 'pg';

import { createSessionBackendConformance } from '@earendil-works/pi-agent-core/session/testing';

import { runMigrations } from '../src/infrastructure/postgres/migrate.js';
import { createPostgresSessionRepo } from '../src/infrastructure/postgres/session/repo.js';

const { Pool } = pg;

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    'postgres://photo_agent:photo_agent@127.0.0.1:54329/photo_agent_test',
});

/** 与 postgres-repository.test.mjs 同一套护栏：拒绝重置非 _test 库。 */
async function resetDatabase() {
  const database = await pool.query('SELECT current_database() AS name');
  if (!database.rows[0].name.endsWith('_test')) {
    throw new Error(
      `Refusing to reset non-test database: ${database.rows[0].name}`,
    );
  }
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations(pool);
}

/** 每个 conformance 用例一个隔离夹具。pool 是共享的，由 after() 关闭。 */
async function createFixture() {
  await resetDatabase();
  return {
    repository: createPostgresSessionRepo({ pool }),
    async [Symbol.asyncDispose]() {
      // 故意留空：pool 由 after() 统一关闭，在这里 end() 会让后续用例全挂
    },
  };
}

for (const conformanceCase of createSessionBackendConformance(createFixture)) {
  test(`conformance: ${conformanceCase.group} > ${conformanceCase.name}`, async () => {
    await conformanceCase.run();
  });
}


