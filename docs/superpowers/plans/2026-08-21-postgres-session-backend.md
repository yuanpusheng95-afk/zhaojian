# 切片 1：PostgreSQL SessionStorage 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 pi Agent Harness 实现一个 PostgreSQL 会话后端，使 Agent 轨迹持久化到本项目已有的 PostgreSQL，并通过 pi 官方 conformance 套件全部 30 个用例。

**Architecture:** 实现 pi 的两个公开契约——`SessionStorage`（17 个方法，append-only 的 entries/records + lane 指针 + kv facts）与 `SessionRepo`（5 个方法：create/open/list/delete/fork）。pi 的 `Session` 类由上游提供，本项目只负责底层存储。分支查询用 PostgreSQL 的 `WITH RECURSIVE` 现算，不建派生缓存表。

**Tech Stack:** Node.js 22+ 原生 ESM（`.mjs`，无构建步骤）、`pg`、`node:test`、`@earendil-works/pi-agent-core@0.84.2`

**设计文档：** `docs/superpowers/specs/2026-08-20-pi-agent-migration-design.md` §11

## Global Constraints

- Node.js `>=22`（`package.json` engines 已声明）
- **不引入构建步骤**：源码是 `.mjs`，直接 `import` pi 发布的 ESM `dist`
- **不引入 vitest**：测试框架继续用 `node:test`
- pi 版本**锁定精确版本** `0.84.2`（0.x 阶段 API 可能变化，升级作为独立任务）
- 新依赖只加 `@earendil-works/pi-agent-core@0.84.2`（本切片不需要 `pi-ai`）
- 本切片**不修改** `src/domain/**`、`src/api/**`、`src/worker/**`
- 迁移文件命名沿用现有序号规则：`migrations/NNN_name.sql`
- 集成测试连真实 PostgreSQL，走现有的 `npm run test:integration`（`scripts/prepare-test-database.mjs` 会重置 `photo_agent_test`）

## 对设计文档的两处修正

实施前已核实，spec §11.2 有两处需要按本计划为准：

1. **验收契约是 `SessionRepo`，不只是 `SessionStorage`。** `SessionBackendFixture` 要求 `readonly repository: SessionRepo`，因此 `create` / `open` / `list` / `delete` / `fork` 都在范围内。spec 把 sqlite 的 `repo.ts` 判为「不是核心」是错的，`fork` 尤其不轻（conformance 有独立的 "repository and forks" 组）。
2. **表数量是 7 张，不是 spec 列的 5 张。** sqlite 参考实现有 10 张，其中 `branch_entries` / `branch_tips` 的注释写明是 "Derived branch cache … exists only to make branch scans cheap"——PostgreSQL 用 `WITH RECURSIVE` 现算即可，这两张省掉。`writer_leases` 也不需要：它解决的是多进程抢 SQLite 文件，PostgreSQL 有真事务。

## 核心语义（实现前必须理解）

**`seq` 是全会话共享的单调序列，每一次 mutation 消耗一个**——不只是 entries。conformance 第一个用例断言：

```text
appendEntry("root", lane=main)   → seq 1
createLane("thread", at=root.id) → seq 2   ← 建 lane 也吃 seq
appendEntry("child", lane=thread) → seq 3
```

这就是 `facts`、`lane_moves` 的主键里带 `seq` 的原因。`appendRecord`、`setName`、`setLabel`、`moveLane` 同样各消耗一个。

**`parentId` 由存储层分配**，值为「追加时该 lane 的当前 leaf」。调用方传入的 `ProvisionedEntry` 不含 `parentId` / `seq` / `timestamp`，三者都由存储层填。上例中 `child.parentId === "root"`，因为 `thread` lane 建在 `root.id` 上。

## File Structure

```text
migrations/009_agent_sessions.sql              7 张表 + 索引
src/infrastructure/postgres/session/
  schema.mjs        表名常量与 JSON 序列化辅助（唯一被所有模块共享的东西）
  sequences.mjs     seq 分配（事务内 UPDATE ... RETURNING）
  sessions.mjs      sessions 表读写（元数据）
  entries.mjs       entries 追加与按 id 读取
  lanes.mjs         lanes 指针 + lane_moves 流水
  records.mjs       records 追加与查询、findOpenOperations
  facts.mjs         name / label 的 latest-wins + getStats
  queries.mjs       findEntries / findEntriesOnBranch(WITH RECURSIVE) / getLog
  storage.mjs       组装成 SessionStorage 的 17 个方法
  repo.mjs          SessionRepo 5 个方法，含 fork
  errors.mjs        SessionError 构造辅助
test-integration/session-storage-conformance.test.mjs   注册 30 个官方用例
test-integration/session-storage-unit.test.mjs          本项目自己的窄用例
```

按职责拆分而非技术分层：`entries.mjs` 同时包含它的 SQL 和它的语义，改一个概念只碰一个文件。`storage.mjs` 只做组装，不含 SQL。

## 测试夹具的既有约定（必须遵守）

`test-integration/postgres-repository.test.mjs` 已经确立了本仓库的集成测试形状，新文件必须照做：

```js
const pool = new Pool({ connectionString });     // 模块级，全文件共享

async function resetDatabase() {
  const database = await pool.query('SELECT current_database() AS name');
  if (!database.rows[0].name.endsWith('_test')) {
    throw new Error(`Refusing to reset non-test database: ${database.rows[0].name}`);
  }
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations(pool);
}

after(async () => { await pool.end(); });
```

三条不可省略的理由：

1. **`_test` 后缀检查是安全护栏。** 若 `DATABASE_URL` 被指向生产库，必须拒绝执行而不是清表。
2. **迁移必须在这里跑。** `scripts/prepare-test-database.mjs` 只 `CREATE DATABASE`，不跑迁移。不调 `runMigrations` 则 `agent_sessions` 表根本不存在。
3. **pool 由 `after()` 统一关闭。** conformance 夹具的 `[Symbol.asyncDispose]` 必须是空实现——它每个用例调一次，若在里面 `pool.end()`，第一个用例跑完后面 29 个全挂。

代价是每个用例都 `DROP SCHEMA` + 跑全部迁移，53 个用例会慢。这是既有约定换来的隔离与安全，第一版不优化。

## 测试文件的共享夹具

`test-integration/session-storage-unit.test.mjs` 是**逐任务追加**的单一文件。Task 2 建立以下辅助，Task 3 补充两个，之后所有任务直接复用——**不要重复定义**：

| 辅助 | 定义于 | 用途 |
|---|---|---|
| `pool` / `connectionString` | Task 2 | 模块级连接池，默认指向 `photo_agent_test` |
| `resetDatabase()` | Task 2 | `_test` 后缀检查 + DROP SCHEMA + `runMigrations` |
| `withClient(fn)` | Task 2 | `resetDatabase()` 后取一个 client 交给 `fn`，结束释放（不关池） |
| `messageEntry(id, text)` | Task 3 | 造一条最小的 `MessageEntry` provisioned 结构 |
| `seedSession(client, id?)` | Task 3 | 插入 session 行并建好 `main` lane，返回 sessionId |
| `startedRecord(id, lane)` | Task 4 | 造 `operation_started` 记录 |
| `finishedRecord(id, lane, runId)` | Task 4 | 造 `operation_finished` 记录 |
| `withRepo(fn)` | Task 8 | `resetDatabase()` 后交出一个 `SessionRepo` |

执行某个任务前，先读一遍该文件已有的顶部导入与辅助定义，只追加自己那部分测试。

---

### Task 1: 依赖、迁移与 conformance 红灯

先把验收标准接进来。本任务结束时 30 个用例全部失败——这是正确的起点。

**Files:**
- Modify: `package.json`
- Create: `migrations/009_agent_sessions.sql`
- Create: `src/infrastructure/postgres/session/schema.mjs`
- Create: `test-integration/session-storage-conformance.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces: `SESSION_TABLES`（表名常量）、`createPostgresSessionRepo({ pool })`（本任务只留桩，Task 9 实现）

- [ ] **Step 1: 装依赖**

```bash
npm install --save-exact @earendil-works/pi-agent-core@0.84.2
```

验证它是 ESM 且能被 `.mjs` 直接 import：

```bash
node -e "import('@earendil-works/pi-agent-core/session/testing').then(m => console.log(Object.keys(m)))"
```

预期输出包含 `createSessionBackendConformance`。

- [ ] **Step 2: 写迁移**

创建 `migrations/009_agent_sessions.sql`：

```sql
CREATE TABLE agent_sessions (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  parent_session_id text REFERENCES agent_sessions(id),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX agent_sessions_created_idx ON agent_sessions(created_at DESC, id);

CREATE TABLE agent_session_sequences (
  session_id text PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
  next_seq bigint NOT NULL DEFAULT 1
);

CREATE TABLE agent_session_entries (
  session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  id text NOT NULL,
  seq bigint NOT NULL,
  parent_id text,
  type text NOT NULL,
  custom_type text,
  timestamp_ms bigint NOT NULL,
  payload_json jsonb NOT NULL,
  PRIMARY KEY (session_id, id),
  UNIQUE (session_id, seq)
);

CREATE INDEX agent_session_entries_parent_idx ON agent_session_entries(session_id, parent_id);
CREATE INDEX agent_session_entries_type_seq_idx ON agent_session_entries(session_id, type, seq);

CREATE TABLE agent_session_lanes (
  session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  lane text NOT NULL,
  leaf_id text,
  PRIMARY KEY (session_id, lane)
);

CREATE TABLE agent_session_lane_moves (
  session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  lane text NOT NULL,
  leaf_id text,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE agent_session_records (
  session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  id text NOT NULL,
  seq bigint NOT NULL,
  lane text NOT NULL,
  run_id text,
  type text NOT NULL,
  op_kind text,
  timestamp_ms bigint NOT NULL,
  payload_json jsonb NOT NULL,
  PRIMARY KEY (session_id, id),
  UNIQUE (session_id, seq)
);

CREATE INDEX agent_session_records_lane_seq_idx ON agent_session_records(session_id, lane, seq);
CREATE INDEX agent_session_records_type_seq_idx ON agent_session_records(session_id, type, seq);
CREATE INDEX agent_session_records_run_idx ON agent_session_records(session_id, run_id, seq);

CREATE TABLE agent_session_facts (
  session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  kind text NOT NULL,
  key text,
  value text,
  PRIMARY KEY (session_id, seq)
);

CREATE INDEX agent_session_facts_kind_key_seq_idx
  ON agent_session_facts(session_id, kind, key, seq DESC);
```

**注意：** 没有 `branch_entries` / `branch_tips`（用 `WITH RECURSIVE` 替代）、没有 `session_stats`（`getStats` 现算）、没有 `writer_leases`（PostgreSQL 有真事务）。

- [ ] **Step 3: 写共享常量**

创建 `src/infrastructure/postgres/session/schema.mjs`：

```js
export const SESSION_TABLES = {
  sessions: 'agent_sessions',
  sequences: 'agent_session_sequences',
  entries: 'agent_session_entries',
  lanes: 'agent_session_lanes',
  laneMoves: 'agent_session_lane_moves',
  records: 'agent_session_records',
  facts: 'agent_session_facts',
};

/** pi 要求 payload 必须是可 JSON 序列化的。不可序列化时抛错，交由调用方转成 SessionError。 */
export function assertJsonSerializable(value, what) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (cause) {
    throw new TypeError(`${what} is not JSON-serializable`, { cause });
  }
  if (serialized === undefined) {
    throw new TypeError(`${what} is not JSON-serializable`);
  }
  return JSON.parse(serialized);
}
```

- [ ] **Step 4: 建 repo 桩**

创建 `src/infrastructure/postgres/session/repo.mjs`：

```js
export function createPostgresSessionRepo({ pool }) {
  if (!pool) throw new TypeError('createPostgresSessionRepo requires a pg pool');
  return {
    async create() {
      throw new Error('not implemented');
    },
    async open() {
      throw new Error('not implemented');
    },
    async list() {
      throw new Error('not implemented');
    },
    async delete() {
      throw new Error('not implemented');
    },
    async fork() {
      throw new Error('not implemented');
    },
  };
}
```

- [ ] **Step 5: 接入 conformance 套件**

创建 `test-integration/session-storage-conformance.test.mjs`：

```js
import { after, test } from 'node:test';
import pg from 'pg';

import { createSessionBackendConformance } from '@earendil-works/pi-agent-core/session/testing';

import { runMigrations } from '../src/infrastructure/postgres/migrate.mjs';
import { createPostgresSessionRepo } from '../src/infrastructure/postgres/session/repo.mjs';

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

after(async () => {
  await pool.end();
});
```

- [ ] **Step 6: 跑迁移并确认 30 个用例全红**

```bash
npm run db:up
node scripts/prepare-test-database.mjs
npm run test:integration 2>&1 | grep -c "^not ok"
```

预期：conformance 用例全部失败，报错为 `not implemented`。这证明套件已正确接入。

记录当前失败数，作为后续任务的基线。

- [ ] **Step 7: 提交**

```bash
git add package.json package-lock.json migrations/009_agent_sessions.sql \
        src/infrastructure/postgres/session/ test-integration/session-storage-conformance.test.mjs
git commit -m "test: wire pi session conformance suite against postgres"
```

---

### Task 2: seq 分配与 session 元数据

**Files:**
- Create: `src/infrastructure/postgres/session/errors.mjs`
- Create: `src/infrastructure/postgres/session/sequences.mjs`
- Create: `src/infrastructure/postgres/session/sessions.mjs`
- Create: `test-integration/session-storage-unit.test.mjs`

**Interfaces:**
- Consumes: `SESSION_TABLES`（Task 1）
- Produces:
  - `sessionError(code, message, cause?) => SessionError`
  - `nextSeq(client, sessionId) => Promise<number>`
  - `insertSession(client, { id, createdAt, parentSessionId, metadata }) => Promise<void>`
  - `readSession(client, id) => Promise<SessionRow | undefined>`
  - `listSessions(client) => Promise<SessionRow[]>`
  - `deleteSession(client, id) => Promise<void>`
  - `SessionRow = { id, createdAt: number, parentSessionId: string|null, metadata: object }`

- [ ] **Step 1: 写失败测试**

在 `test-integration/session-storage-unit.test.mjs`：

```js
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import pg from 'pg';

import { runMigrations } from '../src/infrastructure/postgres/migrate.mjs';
import { nextSeq } from '../src/infrastructure/postgres/session/sequences.mjs';
import {
  insertSession,
  readSession,
} from '../src/infrastructure/postgres/session/sessions.mjs';

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

/** 重置库后交出一个 client。pool 不在这里关闭。 */
async function withClient(fn) {
  await resetDatabase();
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

after(async () => {
  await pool.end();
});

test('nextSeq starts at 1 and increases by one per call', async () => {
  await withClient(async (client) => {
    await insertSession(client, {
      id: 's1',
      createdAt: 1000,
      parentSessionId: null,
      metadata: {},
    });
    assert.equal(await nextSeq(client, 's1'), 1);
    assert.equal(await nextSeq(client, 's1'), 2);
    assert.equal(await nextSeq(client, 's1'), 3);
  });
});

test('sequences are independent per session', async () => {
  await withClient(async (client) => {
    for (const id of ['s1', 's2']) {
      await insertSession(client, {
        id,
        createdAt: 1000,
        parentSessionId: null,
        metadata: {},
      });
    }
    assert.equal(await nextSeq(client, 's1'), 1);
    assert.equal(await nextSeq(client, 's2'), 1);
    assert.equal(await nextSeq(client, 's1'), 2);
  });
});

test('readSession round-trips metadata and parent', async () => {
  await withClient(async (client) => {
    await insertSession(client, {
      id: 'parent',
      createdAt: 1000,
      parentSessionId: null,
      metadata: {},
    });
    await insertSession(client, {
      id: 'child',
      createdAt: 2000,
      parentSessionId: 'parent',
      metadata: { label: 'forked' },
    });
    const row = await readSession(client, 'child');
    assert.deepEqual(row, {
      id: 'child',
      createdAt: 2000,
      parentSessionId: 'parent',
      metadata: { label: 'forked' },
    });
  });
});
```

**注意：** 各用例之间不再共用事务——`withClient` 每次都重置整个 schema，因此不需要 `BEGIN` / `ROLLBACK`。

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test test-integration/session-storage-unit.test.mjs
```

预期：FAIL，`Cannot find module '.../sequences.mjs'`。

- [ ] **Step 3: 写 errors.mjs**

```js
import { SessionError } from '@earendil-works/pi-agent-core';

export function sessionError(code, message, cause) {
  return new SessionError(code, message, cause);
}

/** 把 PostgreSQL 唯一约束冲突（23505）转成 pi 的 already_exists。 */
export function isUniqueViolation(error) {
  return error?.code === '23505';
}
```

- [ ] **Step 4: 写 sequences.mjs**

```js
import { SESSION_TABLES } from './schema.mjs';

/**
 * 分配下一个 seq。全会话共享一条序列——entries、records、lane 变更、facts
 * 每次 mutation 都消耗一个。必须在调用方的事务内执行：行锁保证并发下不重号。
 */
export async function nextSeq(client, sessionId) {
  const result = await client.query(
    `UPDATE ${SESSION_TABLES.sequences}
        SET next_seq = next_seq + 1
      WHERE session_id = $1
      RETURNING next_seq - 1 AS seq`,
    [sessionId],
  );
  if (result.rowCount === 0) {
    throw new Error(`No sequence row for session ${sessionId}`);
  }
  return Number(result.rows[0].seq);
}
```

- [ ] **Step 5: 写 sessions.mjs**

```js
import { SESSION_TABLES } from './schema.mjs';

export async function insertSession(
  client,
  { id, createdAt, parentSessionId, metadata },
) {
  await client.query(
    `INSERT INTO ${SESSION_TABLES.sessions}
       (id, created_at, parent_session_id, metadata_json)
     VALUES ($1, to_timestamp($2 / 1000.0), $3, $4::jsonb)`,
    [id, createdAt, parentSessionId, JSON.stringify(metadata ?? {})],
  );
  await client.query(
    `INSERT INTO ${SESSION_TABLES.sequences} (session_id, next_seq)
     VALUES ($1, 1)`,
    [id],
  );
}

function toRow(row) {
  return {
    id: row.id,
    createdAt: Number(row.created_at_ms),
    parentSessionId: row.parent_session_id,
    metadata: row.metadata_json ?? {},
  };
}

const SELECT_COLUMNS = `
  id,
  (extract(epoch from created_at) * 1000)::bigint AS created_at_ms,
  parent_session_id,
  metadata_json
`;

export async function readSession(client, id) {
  const result = await client.query(
    `SELECT ${SELECT_COLUMNS} FROM ${SESSION_TABLES.sessions} WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? toRow(result.rows[0]) : undefined;
}

export async function listSessions(client) {
  const result = await client.query(
    `SELECT ${SELECT_COLUMNS} FROM ${SESSION_TABLES.sessions}
      ORDER BY created_at DESC, id`,
  );
  return result.rows.map(toRow);
}

export async function deleteSession(client, id) {
  await client.query(`DELETE FROM ${SESSION_TABLES.sessions} WHERE id = $1`, [id]);
}
```

- [ ] **Step 6: 跑测试确认通过**

```bash
node --test test-integration/session-storage-unit.test.mjs
```

预期：3 个用例 PASS。

- [ ] **Step 7: 提交**

```bash
git add src/infrastructure/postgres/session/ test-integration/session-storage-unit.test.mjs
git commit -m "feat: add postgres session sequence and metadata storage"
```

---

### Task 3: entries 追加与 lane 指针

这两个概念必须同一任务完成：`appendEntry` 的 `parentId` 来自 lane 的 leaf，追加后又要推进 leaf——拆开就没有可独立验收的单元。

**Files:**
- Create: `src/infrastructure/postgres/session/lanes.mjs`
- Create: `src/infrastructure/postgres/session/entries.mjs`
- Modify: `test-integration/session-storage-unit.test.mjs`

**Interfaces:**
- Consumes: `nextSeq`（Task 2）、`SESSION_TABLES`、`assertJsonSerializable`
- Produces:
  - `readLanes(client, sessionId) => Promise<{ lane, leafId }[]>`
  - `readLaneLeaf(client, sessionId, lane) => Promise<string|null|undefined>`（`undefined` = lane 不存在）
  - `createLane(client, sessionId, lane, at) => Promise<void>`
  - `moveLane(client, sessionId, lane, to) => Promise<void>`
  - `appendEntry(client, sessionId, provisionedEntry, lane) => Promise<Entry>`
  - `readEntry(client, sessionId, id) => Promise<Entry|undefined>`

- [ ] **Step 1: 写失败测试**

追加到 `test-integration/session-storage-unit.test.mjs`：

```js
import {
  appendEntry,
  readEntry,
} from '../src/infrastructure/postgres/session/entries.mjs';
import {
  createLane,
  moveLane,
  readLaneLeaf,
  readLanes,
} from '../src/infrastructure/postgres/session/lanes.mjs';

function messageEntry(id, text) {
  return {
    type: 'message',
    id,
    message: { role: 'user', content: [{ type: 'text', text }], timestamp: 1 },
  };
}

async function seedSession(client, id = 's1') {
  await insertSession(client, {
    id,
    createdAt: 1000,
    parentSessionId: null,
    metadata: {},
  });
  await createLane(client, id, 'main', null);
  return id;
}

test('one shared sequence advances across entries and lane creation', async () => {
  await withClient(async (client) => {
    const s = await seedSession(client);
    const root = await appendEntry(client, s, messageEntry('root', 'root'), 'main');
    await createLane(client, s, 'thread', root.id);
    const child = await appendEntry(client, s, messageEntry('child', 'child'), 'thread');

    assert.equal(root.seq, 1);
    assert.equal(child.seq, 3, 'createLane must consume seq 2');
  });
});

test('appendEntry assigns parentId from the lane leaf and advances it', async () => {
  await withClient(async (client) => {
    const s = await seedSession(client);
    const root = await appendEntry(client, s, messageEntry('root', 'a'), 'main');
    assert.equal(root.parentId, null, 'first entry on an empty lane has no parent');

    const second = await appendEntry(client, s, messageEntry('second', 'b'), 'main');
    assert.equal(second.parentId, 'root');
    assert.equal(await readLaneLeaf(client, s, 'main'), 'second');
  });
});

test('a new lane inherits the entry it was created at as its leaf', async () => {
  await withClient(async (client) => {
    const s = await seedSession(client);
    const root = await appendEntry(client, s, messageEntry('root', 'a'), 'main');
    await createLane(client, s, 'thread', root.id);
    const child = await appendEntry(client, s, messageEntry('child', 'b'), 'thread');

    assert.equal(child.parentId, 'root');
    assert.equal(await readLaneLeaf(client, s, 'main'), 'root', 'main is untouched');
  });
});

test('moveLane repoints a lane without touching entries', async () => {
  await withClient(async (client) => {
    const s = await seedSession(client);
    const root = await appendEntry(client, s, messageEntry('root', 'a'), 'main');
    await appendEntry(client, s, messageEntry('second', 'b'), 'main');
    await moveLane(client, s, 'main', root.id);

    assert.equal(await readLaneLeaf(client, s, 'main'), 'root');
    assert.ok(await readEntry(client, s, 'second'), 'entry survives the move');
  });
});

test('readEntry round-trips the provisioned payload with assigned fields', async () => {
  await withClient(async (client) => {
    const s = await seedSession(client);
    await appendEntry(client, s, messageEntry('root', 'hello'), 'main');
    const entry = await readEntry(client, s, 'root');

    assert.equal(entry.type, 'message');
    assert.equal(entry.id, 'root');
    assert.equal(entry.seq, 1);
    assert.equal(entry.parentId, null);
    assert.equal(typeof entry.timestamp, 'number');
    assert.equal(entry.message.content[0].text, 'hello');
  });
});

test('readLanes reports every lane with its leaf', async () => {
  await withClient(async (client) => {
    const s = await seedSession(client);
    const root = await appendEntry(client, s, messageEntry('root', 'a'), 'main');
    await createLane(client, s, 'thread', root.id);

    const lanes = await readLanes(client, s);
    assert.deepEqual(
      [...lanes].sort((a, b) => a.lane.localeCompare(b.lane)),
      [
        { lane: 'main', leafId: 'root' },
        { lane: 'thread', leafId: 'root' },
      ],
    );
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test test-integration/session-storage-unit.test.mjs
```

预期：新增 6 个用例 FAIL，`Cannot find module '.../lanes.mjs'`。

- [ ] **Step 3: 写 lanes.mjs**

```js
import { SESSION_TABLES } from './schema.mjs';
import { nextSeq } from './sequences.mjs';

export async function readLanes(client, sessionId) {
  const result = await client.query(
    `SELECT lane, leaf_id FROM ${SESSION_TABLES.lanes} WHERE session_id = $1`,
    [sessionId],
  );
  return result.rows.map((row) => ({ lane: row.lane, leafId: row.leaf_id }));
}

/** 返回 undefined 表示 lane 不存在；返回 null 表示 lane 存在但为空。 */
export async function readLaneLeaf(client, sessionId, lane) {
  const result = await client.query(
    `SELECT leaf_id FROM ${SESSION_TABLES.lanes}
      WHERE session_id = $1 AND lane = $2`,
    [sessionId, lane],
  );
  return result.rows[0] ? result.rows[0].leaf_id : undefined;
}

async function recordLaneMove(client, sessionId, lane, leafId) {
  const seq = await nextSeq(client, sessionId);
  await client.query(
    `INSERT INTO ${SESSION_TABLES.laneMoves} (session_id, seq, lane, leaf_id)
     VALUES ($1, $2, $3, $4)`,
    [sessionId, seq, lane, leafId],
  );
  return seq;
}

/** 建 lane 也消耗一个 seq——conformance 的第一个用例依赖这一点。 */
export async function createLane(client, sessionId, lane, at) {
  await client.query(
    `INSERT INTO ${SESSION_TABLES.lanes} (session_id, lane, leaf_id)
     VALUES ($1, $2, $3)`,
    [sessionId, lane, at],
  );
  await recordLaneMove(client, sessionId, lane, at);
}

export async function moveLane(client, sessionId, lane, to) {
  await client.query(
    `UPDATE ${SESSION_TABLES.lanes} SET leaf_id = $3
      WHERE session_id = $1 AND lane = $2`,
    [sessionId, lane, to],
  );
  await recordLaneMove(client, sessionId, lane, to);
}

/** 追加 entry 后推进 leaf，不产生 lane_move 流水——它属于 entry 的 mutation。 */
export async function advanceLaneLeaf(client, sessionId, lane, leafId) {
  await client.query(
    `UPDATE ${SESSION_TABLES.lanes} SET leaf_id = $3
      WHERE session_id = $1 AND lane = $2`,
    [sessionId, lane, leafId],
  );
}
```

- [ ] **Step 4: 写 entries.mjs**

```js
import { assertJsonSerializable, SESSION_TABLES } from './schema.mjs';
import { advanceLaneLeaf, readLaneLeaf } from './lanes.mjs';
import { nextSeq } from './sequences.mjs';

/** 存储层分配 parentId / seq / timestamp，调用方只提供其余字段。 */
export async function appendEntry(client, sessionId, provisioned, lane) {
  const { type, id, ...rest } = provisioned;
  const payload = assertJsonSerializable(rest, `entry ${id}`);

  const leafId = await readLaneLeaf(client, sessionId, lane);
  if (leafId === undefined) {
    throw new Error(`Unknown lane ${lane}`);
  }

  const seq = await nextSeq(client, sessionId);
  const timestamp = Date.now();

  await client.query(
    `INSERT INTO ${SESSION_TABLES.entries}
       (session_id, id, seq, parent_id, type, custom_type, timestamp_ms, payload_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      sessionId,
      id,
      seq,
      leafId,
      type,
      type === 'custom' ? (rest.customType ?? null) : null,
      timestamp,
      JSON.stringify(payload),
    ],
  );

  await advanceLaneLeaf(client, sessionId, lane, id);

  return { ...payload, type, id, seq, parentId: leafId, timestamp };
}

export function rowToEntry(row) {
  return {
    ...row.payload_json,
    type: row.type,
    id: row.id,
    seq: Number(row.seq),
    parentId: row.parent_id,
    timestamp: Number(row.timestamp_ms),
  };
}

export const ENTRY_COLUMNS = 'id, seq, parent_id, type, custom_type, timestamp_ms, payload_json';

export async function readEntry(client, sessionId, id) {
  const result = await client.query(
    `SELECT ${ENTRY_COLUMNS} FROM ${SESSION_TABLES.entries}
      WHERE session_id = $1 AND id = $2`,
    [sessionId, id],
  );
  return result.rows[0] ? rowToEntry(result.rows[0]) : undefined;
}
```

- [ ] **Step 5: 跑测试确认通过**

```bash
node --test test-integration/session-storage-unit.test.mjs
```

预期：全部 9 个用例 PASS。

- [ ] **Step 6: 提交**

```bash
git add src/infrastructure/postgres/session/ test-integration/session-storage-unit.test.mjs
git commit -m "feat: add postgres session entries and lane pointers"
```

---

### Task 4: records 与 findOpenOperations

**Files:**
- Create: `src/infrastructure/postgres/session/records.mjs`
- Modify: `test-integration/session-storage-unit.test.mjs`

**Interfaces:**
- Consumes: `nextSeq`、`SESSION_TABLES`、`assertJsonSerializable`
- Produces:
  - `appendRecord(client, sessionId, newRecord) => Promise<Record>`
  - `findRecords(client, sessionId, query) => Promise<Record[]>`，`query = { type?, lane?, runId?, order?: 'asc'|'desc', limit? }`
  - `findOpenOperations(client, sessionId, lane, { limit }) => Promise<OperationStartedRecord[]>`

- [ ] **Step 1: 写失败测试**

```js
import {
  appendRecord,
  findOpenOperations,
  findRecords,
} from '../src/infrastructure/postgres/session/records.mjs';

function startedRecord(id, lane) {
  return {
    type: 'operation_started',
    id,
    lane,
    sourceLeafId: null,
    intent: { kind: 'run', originalPrompt: [], initialMessages: [] },
  };
}

function finishedRecord(id, lane, runId) {
  return { type: 'operation_finished', id, lane, runId, outcome: 'completed' };
}

test('appendRecord assigns seq from the shared sequence', async () => {
  await withClient(async (client) => {
    const s = await seedSession(client);
    await appendEntry(client, s, messageEntry('root', 'a'), 'main');
    const record = await appendRecord(client, s, startedRecord('run-1', 'main'));
    assert.equal(record.seq, 2, 'entry took seq 1');
    assert.equal(record.lane, 'main');
    assert.equal(typeof record.timestamp, 'number');
  });
});

test('findRecords filters by type and lane', async () => {
  await withClient(async (client) => {
    const s = await seedSession(client);
    await createLane(client, s, 'side', null);
    await appendRecord(client, s, startedRecord('a', 'main'));
    await appendRecord(client, s, startedRecord('b', 'side'));
    await appendRecord(client, s, finishedRecord('c', 'main', 'a'));

    const started = await findRecords(client, s, { type: 'operation_started' });
    assert.deepEqual(started.map((r) => r.id), ['a', 'b']);

    const mainOnly = await findRecords(client, s, { lane: 'main' });
    assert.deepEqual(mainOnly.map((r) => r.id), ['a', 'c']);
  });
});

test('findOpenOperations returns newest first and excludes finished runs', async () => {
  await withClient(async (client) => {
    const s = await seedSession(client);
    await appendRecord(client, s, startedRecord('run-1', 'main'));
    await appendRecord(client, s, startedRecord('run-2', 'main'));
    await appendRecord(client, s, finishedRecord('fin-1', 'main', 'run-1'));

    const open = await findOpenOperations(client, s, 'main', { limit: 2 });
    assert.deepEqual(open.map((r) => r.id), ['run-2']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test test-integration/session-storage-unit.test.mjs
```

预期：新增 3 个用例 FAIL。

- [ ] **Step 3: 写 records.mjs**

```js
import { assertJsonSerializable, SESSION_TABLES } from './schema.mjs';
import { nextSeq } from './sequences.mjs';

const RECORD_COLUMNS = 'id, seq, lane, run_id, type, op_kind, timestamp_ms, payload_json';

function rowToRecord(row) {
  return {
    ...row.payload_json,
    type: row.type,
    id: row.id,
    seq: Number(row.seq),
    lane: row.lane,
    timestamp: Number(row.timestamp_ms),
  };
}

export async function appendRecord(client, sessionId, newRecord) {
  const { type, id, lane, ...rest } = newRecord;
  const payload = assertJsonSerializable(rest, `record ${id}`);

  const seq = await nextSeq(client, sessionId);
  const timestamp = Date.now();

  await client.query(
    `INSERT INTO ${SESSION_TABLES.records}
       (session_id, id, seq, lane, run_id, type, op_kind, timestamp_ms, payload_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      sessionId,
      id,
      seq,
      lane,
      rest.runId ?? null,
      type,
      rest.intent?.kind ?? null,
      timestamp,
      JSON.stringify(payload),
    ],
  );

  return { ...payload, type, id, seq, lane, timestamp };
}

export async function findRecords(client, sessionId, query = {}) {
  const conditions = ['session_id = $1'];
  const params = [sessionId];

  for (const [column, value] of [
    ['type', query.type],
    ['lane', query.lane],
    ['run_id', query.runId],
  ]) {
    if (value !== undefined) {
      params.push(value);
      conditions.push(`${column} = $${params.length}`);
    }
  }

  let sql = `SELECT ${RECORD_COLUMNS} FROM ${SESSION_TABLES.records}
              WHERE ${conditions.join(' AND ')}
              ORDER BY seq ${query.order === 'desc' ? 'DESC' : 'ASC'}`;

  if (query.limit !== undefined) {
    params.push(query.limit);
    sql += ` LIMIT $${params.length}`;
  }

  const result = await client.query(sql, params);
  return result.rows.map(rowToRecord);
}

/**
 * 未闭合的 operation_started：不存在引用其 id 的 operation_finished。
 * 按 seq 倒序返回——恢复逻辑用 limit:2 判断 idle / suspended / 损坏。
 */
export async function findOpenOperations(client, sessionId, lane, options = {}) {
  const params = [sessionId, lane];
  let sql = `
    SELECT ${RECORD_COLUMNS}
      FROM ${SESSION_TABLES.records} started
     WHERE started.session_id = $1
       AND started.lane = $2
       AND started.type = 'operation_started'
       AND NOT EXISTS (
         SELECT 1 FROM ${SESSION_TABLES.records} finished
          WHERE finished.session_id = started.session_id
            AND finished.type = 'operation_finished'
            AND finished.run_id = started.id
       )
     ORDER BY started.seq DESC`;

  if (options.limit !== undefined) {
    params.push(options.limit);
    sql += ` LIMIT $${params.length}`;
  }

  const result = await client.query(sql, params);
  return result.rows.map(rowToRecord);
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
node --test test-integration/session-storage-unit.test.mjs
```

预期：全部 12 个用例 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/infrastructure/postgres/session/records.mjs test-integration/session-storage-unit.test.mjs
git commit -m "feat: add postgres session records and open-operation lookup"
```

---

### Task 5: facts 与 stats

**Files:**
- Create: `src/infrastructure/postgres/session/facts.mjs`
- Modify: `test-integration/session-storage-unit.test.mjs`

**Interfaces:**
- Consumes: `nextSeq`、`SESSION_TABLES`
- Produces:
  - `setFact(client, sessionId, kind, key, value) => Promise<void>`（latest-wins）
  - `getFact(client, sessionId, kind, key) => Promise<string|undefined>`
  - `computeStats(client, sessionId) => Promise<SessionStats>`

- [ ] **Step 1: 写失败测试**

```js
import {
  computeStats,
  getFact,
  setFact,
} from '../src/infrastructure/postgres/session/facts.mjs';

test('facts are latest-wins per kind and key', async () => {
  await withClient(async (client) => {
    const s = await seedSession(client);
    await setFact(client, s, 'name', null, 'First');
    await setFact(client, s, 'name', null, 'Second');
    assert.equal(await getFact(client, s, 'name', null), 'Second');
  });
});

test('labels are keyed independently', async () => {
  await withClient(async (client) => {
    const s = await seedSession(client);
    await setFact(client, s, 'label', 'e1', 'checkpoint');
    await setFact(client, s, 'label', 'e2', 'other');
    assert.equal(await getFact(client, s, 'label', 'e1'), 'checkpoint');
    assert.equal(await getFact(client, s, 'label', 'e2'), 'other');
  });
});

test('clearing a fact stores null and reads back undefined', async () => {
  await withClient(async (client) => {
    const s = await seedSession(client);
    await setFact(client, s, 'name', null, 'Named');
    await setFact(client, s, 'name', null, undefined);
    assert.equal(await getFact(client, s, 'name', null), undefined);
  });
});

test('computeStats counts messages and sums assistant usage', async () => {
  await withClient(async (client) => {
    const s = await seedSession(client);
    await appendEntry(client, s, messageEntry('u1', 'hi'), 'main');
    await appendEntry(
      client,
      s,
      {
        type: 'message',
        id: 'a1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'yo' }],
          api: 'anthropic-messages',
          provider: 'anthropic',
          model: 'claude-sonnet-4-5',
          usage: {
            input: 10,
            output: 5,
            cacheRead: 2,
            cacheWrite: 1,
            totalTokens: 18,
            cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
          },
          stopReason: 'stop',
          timestamp: 1,
        },
      },
      'main',
    );

    const stats = await computeStats(client, s);
    assert.equal(stats.messageCount, 2);
    assert.equal(stats.totalTokens, 18);
    assert.equal(stats.costTotal, 0.3);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test test-integration/session-storage-unit.test.mjs
```

预期：新增 4 个用例 FAIL。

- [ ] **Step 3: 写 facts.mjs**

```js
import { SESSION_TABLES } from './schema.mjs';
import { nextSeq } from './sequences.mjs';

/** 追加一条 fact，读取时取同 (kind, key) 下 seq 最大的一条——latest wins。 */
export async function setFact(client, sessionId, kind, key, value) {
  const seq = await nextSeq(client, sessionId);
  await client.query(
    `INSERT INTO ${SESSION_TABLES.facts} (session_id, seq, kind, key, value)
     VALUES ($1, $2, $3, $4, $5)`,
    [sessionId, seq, kind, key, value ?? null],
  );
}

export async function getFact(client, sessionId, kind, key) {
  const result = await client.query(
    `SELECT value FROM ${SESSION_TABLES.facts}
      WHERE session_id = $1 AND kind = $2 AND key IS NOT DISTINCT FROM $3
      ORDER BY seq DESC
      LIMIT 1`,
    [sessionId, kind, key],
  );
  const value = result.rows[0]?.value;
  return value === null ? undefined : value;
}

/** 现算，不维护 session_stats 表——会话规模有限，省一处会不同步的派生状态。 */
export async function computeStats(client, sessionId) {
  const result = await client.query(
    `SELECT
       count(*) FILTER (WHERE type = 'message') AS message_count,
       coalesce(sum((payload_json -> 'message' -> 'usage' ->> 'cacheRead')::numeric), 0) AS cached_tokens,
       coalesce(sum((payload_json -> 'message' -> 'usage' ->> 'input')::numeric), 0)
         + coalesce(sum((payload_json -> 'message' -> 'usage' ->> 'output')::numeric), 0) AS uncached_tokens,
       coalesce(sum((payload_json -> 'message' -> 'usage' ->> 'totalTokens')::numeric), 0) AS total_tokens,
       coalesce(sum((payload_json -> 'message' -> 'usage' -> 'cost' ->> 'total')::numeric), 0) AS cost_total
     FROM ${SESSION_TABLES.entries}
     WHERE session_id = $1`,
    [sessionId],
  );
  const row = result.rows[0];
  return {
    messageCount: Number(row.message_count),
    cachedTokens: Number(row.cached_tokens),
    uncachedTokens: Number(row.uncached_tokens),
    totalTokens: Number(row.total_tokens),
    costTotal: Number(row.cost_total),
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
node --test test-integration/session-storage-unit.test.mjs
```

预期：全部 16 个用例 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/infrastructure/postgres/session/facts.mjs test-integration/session-storage-unit.test.mjs
git commit -m "feat: add postgres session facts and stats"
```

---

### Task 6: 查询——findEntries、分支扫描、getLog

分支扫描是本切片技术上最有意思的一步：sqlite 参考实现靠 `branch_entries` 派生缓存表，PostgreSQL 用 `WITH RECURSIVE` 沿 `parent_id` 现算，省掉一张需要维护一致性的表。

**Files:**
- Create: `src/infrastructure/postgres/session/queries.mjs`
- Modify: `test-integration/session-storage-unit.test.mjs`

**Interfaces:**
- Consumes: `SESSION_TABLES`、`rowToEntry`、`ENTRY_COLUMNS`（Task 3）
- Produces:
  - `findEntries(client, sessionId, query) => Promise<Entry[]>`
  - `findEntriesOnBranch(client, sessionId, query) => Promise<Entry[]>`，`query = { start, type?, customType?, limit?, order? }`
  - `getLog(client, sessionId, { afterSeq, limit }) => Promise<LogItem[]>`

- [ ] **Step 1: 写失败测试**

```js
import {
  findEntries,
  findEntriesOnBranch,
  getLog,
} from '../src/infrastructure/postgres/session/queries.mjs';

test('findEntries returns every entry in sequence order', async () => {
  await withClient(async (client) => {
    const s = await seedSession(client);
    await appendEntry(client, s, messageEntry('a', '1'), 'main');
    await appendEntry(client, s, messageEntry('b', '2'), 'main');
    const entries = await findEntries(client, s, {});
    assert.deepEqual(entries.map((e) => e.id), ['a', 'b']);
  });
});

test('findEntriesOnBranch walks parent links from the start entry to the root', async () => {
  await withClient(async (client) => {
    const s = await seedSession(client);
    const a = await appendEntry(client, s, messageEntry('a', '1'), 'main');
    await appendEntry(client, s, messageEntry('b', '2'), 'main');
    // 从 a 分叉出 side 分支
    await createLane(client, s, 'side', a.id);
    await appendEntry(client, s, messageEntry('c', '3'), 'side');

    const branch = await findEntriesOnBranch(client, s, { start: 'c' });
    assert.deepEqual(
      branch.map((e) => e.id),
      ['a', 'c'],
      'b is on a different branch and must be excluded',
    );
  });
});

test('findEntriesOnBranch filters by type', async () => {
  await withClient(async (client) => {
    const s = await seedSession(client);
    await appendEntry(client, s, messageEntry('a', '1'), 'main');
    await appendEntry(
      client,
      s,
      { type: 'custom', id: 'n1', customType: 'note', data: { value: 1 } },
      'main',
    );
    const notes = await findEntriesOnBranch(client, s, { start: 'n1', type: 'custom' });
    assert.deepEqual(notes.map((e) => e.id), ['n1']);
  });
});

test('getLog merges entries records and lane moves in one sequence', async () => {
  await withClient(async (client) => {
    const s = await seedSession(client);
    await appendEntry(client, s, messageEntry('a', '1'), 'main');
    await appendRecord(client, s, startedRecord('run-1', 'main'));
    await moveLane(client, s, 'main', 'a');

    const log = await getLog(client, s, {});
    assert.deepEqual(log.map((item) => item.seq), [1, 2, 3]);
    assert.deepEqual(log.map((item) => item.kind), ['entry', 'record', 'lane_move']);
  });
});

test('getLog honours the afterSeq cursor', async () => {
  await withClient(async (client) => {
    const s = await seedSession(client);
    await appendEntry(client, s, messageEntry('a', '1'), 'main');
    await appendEntry(client, s, messageEntry('b', '2'), 'main');
    const tail = await getLog(client, s, { afterSeq: 1 });
    assert.deepEqual(tail.map((item) => item.seq), [2]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test test-integration/session-storage-unit.test.mjs
```

预期：新增 5 个用例 FAIL。

- [ ] **Step 3: 写 queries.mjs**

```js
import { ENTRY_COLUMNS, rowToEntry } from './entries.mjs';
import { SESSION_TABLES } from './schema.mjs';

function applyEntryFilters(query, conditions, params, prefix = '') {
  for (const [column, value] of [
    ['type', query.type],
    ['custom_type', query.customType],
  ]) {
    if (value !== undefined) {
      params.push(value);
      conditions.push(`${prefix}${column} = $${params.length}`);
    }
  }
}

export async function findEntries(client, sessionId, query = {}) {
  const conditions = ['session_id = $1'];
  const params = [sessionId];
  applyEntryFilters(query, conditions, params);

  let sql = `SELECT ${ENTRY_COLUMNS} FROM ${SESSION_TABLES.entries}
              WHERE ${conditions.join(' AND ')}
              ORDER BY seq ${query.order === 'desc' ? 'DESC' : 'ASC'}`;

  if (query.limit !== undefined) {
    params.push(query.limit);
    sql += ` LIMIT $${params.length}`;
  }

  const result = await client.query(sql, params);
  return result.rows.map(rowToEntry);
}

/**
 * 沿 parent_id 从 start 回溯到根，得到该分支的全部 entry。
 * sqlite 后端为此维护 branch_entries 派生缓存；PostgreSQL 用递归 CTE 现算，
 * 少一张需要维护一致性的表。
 */
export async function findEntriesOnBranch(client, sessionId, query = {}) {
  if (!query.start) {
    throw new Error('findEntriesOnBranch requires a start entry id');
  }

  const conditions = [];
  const params = [sessionId, query.start];
  applyEntryFilters(query, conditions, params, 'b.');

  let sql = `
    WITH RECURSIVE branch AS (
      SELECT ${ENTRY_COLUMNS}
        FROM ${SESSION_TABLES.entries}
       WHERE session_id = $1 AND id = $2
      UNION ALL
      SELECT e.${ENTRY_COLUMNS.split(', ').join(', e.')}
        FROM ${SESSION_TABLES.entries} e
        JOIN branch ON e.id = branch.parent_id
       WHERE e.session_id = $1
    )
    SELECT ${ENTRY_COLUMNS} FROM branch b
    ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
    ORDER BY seq ${query.order === 'desc' ? 'DESC' : 'ASC'}`;

  if (query.limit !== undefined) {
    params.push(query.limit);
    sql += ` LIMIT $${params.length}`;
  }

  const result = await client.query(sql, params);
  return result.rows.map(rowToEntry);
}

/**
 * 会话的统一变更流水，按共享 seq 排序。afterSeq 是增量游标——
 * 将来的 SSE 端点（设计文档切片 3）直接建在它上面。
 */
export async function getLog(client, sessionId, options = {}) {
  const params = [sessionId];
  let cursor = '';
  if (options.afterSeq !== undefined) {
    params.push(options.afterSeq);
    cursor = `AND seq > $${params.length}`;
  }

  let sql = `
    SELECT seq, 'entry' AS kind, to_jsonb(e) AS item
      FROM (SELECT ${ENTRY_COLUMNS} FROM ${SESSION_TABLES.entries}
             WHERE session_id = $1 ${cursor}) e
    UNION ALL
    SELECT seq, 'record' AS kind, to_jsonb(r) AS item
      FROM (SELECT id, seq, lane, run_id, type, timestamp_ms, payload_json
              FROM ${SESSION_TABLES.records}
             WHERE session_id = $1 ${cursor}) r
    UNION ALL
    SELECT seq, 'lane_move' AS kind, to_jsonb(m) AS item
      FROM (SELECT seq, lane, leaf_id FROM ${SESSION_TABLES.laneMoves}
             WHERE session_id = $1 ${cursor}) m
    ORDER BY seq ASC`;

  if (options.limit !== undefined) {
    params.push(options.limit);
    sql += ` LIMIT $${params.length}`;
  }

  const result = await client.query(sql, params);
  return result.rows.map((row) => ({
    seq: Number(row.seq),
    kind: row.kind,
    item: row.item,
  }));
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
node --test test-integration/session-storage-unit.test.mjs
```

预期：全部 21 个用例 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/infrastructure/postgres/session/queries.mjs test-integration/session-storage-unit.test.mjs
git commit -m "feat: add postgres session queries with recursive branch scan"
```

---

### Task 7: 组装 SessionStorage 的 17 个方法

把前面各模块拼成 pi 要的接口。本任务不含 SQL——所有 SQL 都在被组装的模块里。

**Files:**
- Create: `src/infrastructure/postgres/session/storage.mjs`
- Modify: `test-integration/session-storage-unit.test.mjs`

**Interfaces:**
- Consumes: Task 2–6 的全部导出
- Produces: `createPostgresSessionStorage({ pool, sessionId }) => SessionStorage`

- [ ] **Step 1: 写失败测试**

```js
import { createPostgresSessionStorage } from '../src/infrastructure/postgres/session/storage.mjs';

test('storage exposes every method the SessionStorage contract requires', async () => {
  const storage = createPostgresSessionStorage({ pool, sessionId: 's1' });
  for (const method of [
    'getMetadata',
    'getLanes',
    'createLane',
    'moveLane',
    'appendEntry',
    'appendRecord',
    'getEntry',
    'findEntries',
    'findEntriesOnBranch',
    'findRecords',
    'findOpenOperations',
    'getLog',
    'getName',
    'setName',
    'getLabel',
    'setLabel',
    'getStats',
  ]) {
    assert.equal(typeof storage[method], 'function', `missing ${method}`);
  }
});

test('every mutation runs in its own transaction and shares the sequence', async () => {
  await resetDatabase();
  const client = await pool.connect();
  try {
    await insertSession(client, {
      id: 's1',
      createdAt: 1000,
      parentSessionId: null,
      metadata: {},
    });
  } finally {
    client.release();
  }

  const storage = createPostgresSessionStorage({ pool, sessionId: 's1' });
  await storage.createLane('main', null);
  const root = await storage.appendEntry(
    { type: 'message', id: 'root', message: { role: 'user', content: [], timestamp: 1 } },
    'main',
  );
  await storage.setName('Example');

  assert.equal(root.seq, 2, 'createLane consumed seq 1');
  assert.equal(await storage.getName(), 'Example');
  assert.equal((await storage.getEntry('root')).id, 'root');
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test test-integration/session-storage-unit.test.mjs
```

预期：新增 2 个用例 FAIL。

- [ ] **Step 3: 写 storage.mjs**

```js
import { appendEntry, readEntry } from './entries.mjs';
import { sessionError } from './errors.mjs';
import { computeStats, getFact, setFact } from './facts.mjs';
import { createLane, moveLane, readLanes } from './lanes.mjs';
import {
  findEntries,
  findEntriesOnBranch,
  getLog,
} from './queries.mjs';
import { appendRecord, findOpenOperations, findRecords } from './records.mjs';
import { readSession } from './sessions.mjs';

export function createPostgresSessionStorage({ pool, sessionId }) {
  if (!pool) throw new TypeError('createPostgresSessionStorage requires a pg pool');
  if (!sessionId) throw new TypeError('createPostgresSessionStorage requires a sessionId');

  /** 每个 mutation 一个事务：seq 分配与写入必须原子，否则并发下会重号。 */
  async function inTransaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw translate(error);
    } finally {
      client.release();
    }
  }

  async function withClient(fn) {
    const client = await pool.connect();
    try {
      return await fn(client);
    } catch (error) {
      throw translate(error);
    } finally {
      client.release();
    }
  }

  function translate(error) {
    if (error?.name === 'SessionError') return error;
    if (error?.code === '23505') {
      return sessionError('already_exists', error.message, error);
    }
    if (error instanceof TypeError) {
      return sessionError('invalid_payload', error.message, error);
    }
    return sessionError('storage', error?.message ?? String(error), error);
  }

  return {
    async getMetadata() {
      const row = await withClient((client) => readSession(client, sessionId));
      if (!row) throw sessionError('not_found', `Session ${sessionId} not found`);
      return { id: row.id, createdAt: row.createdAt, ...row.metadata };
    },

    getLanes: () => withClient((client) => readLanes(client, sessionId)),
    createLane: (lane, at) =>
      inTransaction((client) => createLane(client, sessionId, lane, at)),
    moveLane: (lane, to) =>
      inTransaction((client) => moveLane(client, sessionId, lane, to)),

    appendEntry: (entry, lane) =>
      inTransaction((client) => appendEntry(client, sessionId, entry, lane)),
    appendRecord: (record) =>
      inTransaction((client) => appendRecord(client, sessionId, record)),

    getEntry: (id) => withClient((client) => readEntry(client, sessionId, id)),
    findEntries: (query) => withClient((client) => findEntries(client, sessionId, query)),
    findEntriesOnBranch: (query) =>
      withClient((client) => findEntriesOnBranch(client, sessionId, query)),
    findRecords: (query) => withClient((client) => findRecords(client, sessionId, query)),
    findOpenOperations: (lane, options) =>
      withClient((client) => findOpenOperations(client, sessionId, lane, options)),
    getLog: (options) => withClient((client) => getLog(client, sessionId, options)),

    getName: () => withClient((client) => getFact(client, sessionId, 'name', null)),
    setName: (name) =>
      inTransaction((client) => setFact(client, sessionId, 'name', null, name)),
    getLabel: (id) => withClient((client) => getFact(client, sessionId, 'label', id)),
    setLabel: (id, label) =>
      inTransaction((client) => setFact(client, sessionId, 'label', id, label)),

    getStats: () => withClient((client) => computeStats(client, sessionId)),
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
node --test test-integration/session-storage-unit.test.mjs
```

预期：全部 23 个用例 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/infrastructure/postgres/session/storage.mjs test-integration/session-storage-unit.test.mjs
git commit -m "feat: assemble postgres SessionStorage contract"
```

---

### Task 8: SessionRepo 与 fork

`fork` 是 conformance "repository and forks" 组的核心：从源会话的某个分支复制 entries 到新会话，**不复制 records**，并按选项复制部分 facts。源会话必须完全不变。

**Files:**
- Modify: `src/infrastructure/postgres/session/repo.mjs`
- Modify: `test-integration/session-storage-unit.test.mjs`

**Interfaces:**
- Consumes: Task 2–7 的全部导出、pi 的 `Session` 类
- Produces: `createPostgresSessionRepo({ pool })` 实现完整的 `SessionRepo`

- [ ] **Step 1: 写失败测试**

```js
import { createPostgresSessionRepo } from '../src/infrastructure/postgres/session/repo.mjs';

async function withRepo(fn) {
  await resetDatabase();
  return fn(createPostgresSessionRepo({ pool }));
}

test('create returns a Session and list reports it', async () => {
  await withRepo(async (repo) => {
    const session = await repo.create({ id: 'session-1' });
    assert.equal(typeof session.appendEntry, 'function');
    const listed = await repo.list();
    assert.deepEqual(listed.map((m) => m.id), ['session-1']);
  });
});

test('create rejects a duplicate id with already_exists', async () => {
  await withRepo(async (repo) => {
    await repo.create({ id: 'dup' });
    await assert.rejects(
      () => repo.create({ id: 'dup' }),
      (error) => error.code === 'already_exists',
    );
  });
});

test('open rejects an unknown session with not_found', async () => {
  await withRepo(async (repo) => {
    await assert.rejects(
      () => repo.open({ id: 'missing' }),
      (error) => error.code === 'not_found',
    );
  });
});

test('fork copies the branch entries and leaves the source untouched', async () => {
  await withRepo(async (repo) => {
    const source = await repo.create({ id: 'src' });
    const a = await source.appendEntry(
      { type: 'message', id: 'a', message: { role: 'user', content: [], timestamp: 1 } },
      'main',
    );
    await source.appendEntry(
      { type: 'message', id: 'b', message: { role: 'user', content: [], timestamp: 1 } },
      'main',
    );

    const forked = await repo.fork({ id: 'src' }, { id: 'fork', at: a.id });

    assert.deepEqual(
      (await forked.findEntries()).map((e) => e.id),
      ['a'],
      'fork carries only the branch up to the fork point',
    );
    assert.deepEqual(
      (await source.findEntries()).map((e) => e.id),
      ['a', 'b'],
      'source must be unchanged',
    );
  });
});

test('fork does not copy records', async () => {
  await withRepo(async (repo) => {
    const source = await repo.create({ id: 'src' });
    const a = await source.appendEntry(
      { type: 'message', id: 'a', message: { role: 'user', content: [], timestamp: 1 } },
      'main',
    );
    await source.appendRecord({
      type: 'operation_started',
      id: 'run-1',
      lane: 'main',
      sourceLeafId: null,
      intent: { kind: 'run', originalPrompt: [], initialMessages: [] },
    });

    const forked = await repo.fork({ id: 'src' }, { id: 'fork', at: a.id });
    assert.deepEqual(await forked.findRecords(), []);
  });
});

test('delete removes the session and cascades its rows', async () => {
  await withRepo(async (repo) => {
    const session = await repo.create({ id: 'gone' });
    await session.appendEntry(
      { type: 'message', id: 'a', message: { role: 'user', content: [], timestamp: 1 } },
      'main',
    );
    await repo.delete({ id: 'gone' });
    assert.deepEqual(await repo.list(), []);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test test-integration/session-storage-unit.test.mjs
```

预期：新增 6 个用例 FAIL（`not implemented`）。

- [ ] **Step 3: 实现 repo.mjs**

```js
import { Session } from '@earendil-works/pi-agent-core';

import { rowToEntry } from './entries.mjs';
import { isUniqueViolation, sessionError } from './errors.mjs';
import { createLane } from './lanes.mjs';
import { findEntriesOnBranch } from './queries.mjs';
import { SESSION_TABLES } from './schema.mjs';
import {
  deleteSession,
  insertSession,
  listSessions,
  readSession,
} from './sessions.mjs';
import { nextSeq } from './sequences.mjs';
import { createPostgresSessionStorage } from './storage.mjs';

const DEFAULT_LANE = 'main';

export function createPostgresSessionRepo({ pool }) {
  if (!pool) throw new TypeError('createPostgresSessionRepo requires a pg pool');

  async function inTransaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (isUniqueViolation(error)) {
        throw sessionError('already_exists', error.message, error);
      }
      throw error?.name === 'SessionError'
        ? error
        : sessionError('storage', error?.message ?? String(error), error);
    } finally {
      client.release();
    }
  }

  function openStorage(id) {
    return new Session(createPostgresSessionStorage({ pool, sessionId: id }));
  }

  async function requireSession(client, id) {
    const row = await readSession(client, id);
    if (!row) throw sessionError('not_found', `Session ${id} not found`);
    return row;
  }

  return {
    async create(options) {
      const id = options?.id;
      if (!id) throw sessionError('invalid_payload', 'create requires an id');
      await inTransaction(async (client) => {
        await insertSession(client, {
          id,
          createdAt: Date.now(),
          parentSessionId: null,
          metadata: options.metadata ?? {},
        });
        await createLane(client, id, DEFAULT_LANE, null);
      });
      return openStorage(id);
    },

    async open(metadata) {
      await inTransaction((client) => requireSession(client, metadata.id));
      return openStorage(metadata.id);
    },

    async list() {
      const client = await pool.connect();
      try {
        const rows = await listSessions(client);
        return rows.map((row) => ({
          id: row.id,
          createdAt: row.createdAt,
          ...row.metadata,
        }));
      } finally {
        client.release();
      }
    },

    async delete(metadata) {
      await inTransaction(async (client) => {
        await requireSession(client, metadata.id);
        await deleteSession(client, metadata.id);
      });
    },

    /**
     * 复制源分支上的 entries 到新会话，records 不复制。
     * 源会话完全只读——所有写入都发生在新 session_id 下。
     */
    async fork(source, options) {
      const targetId = options?.id;
      if (!targetId) throw sessionError('invalid_payload', 'fork requires a target id');
      const at = options.at ?? null;

      await inTransaction(async (client) => {
        await requireSession(client, source.id);

        const branch = at
          ? await findEntriesOnBranch(client, source.id, { start: at })
          : [];
        if (at && branch.length === 0) {
          throw sessionError('invalid_fork_target', `Unknown fork target ${at}`);
        }

        await insertSession(client, {
          id: targetId,
          createdAt: Date.now(),
          parentSessionId: source.id,
          metadata: options.metadata ?? {},
        });

        let parentId = null;
        for (const entry of branch) {
          const seq = await nextSeq(client, targetId);
          const { type, id, seq: _seq, parentId: _parent, timestamp, ...payload } = entry;
          await client.query(
            `INSERT INTO ${SESSION_TABLES.entries}
               (session_id, id, seq, parent_id, type, custom_type, timestamp_ms, payload_json)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
            [
              targetId,
              id,
              seq,
              parentId,
              type,
              type === 'custom' ? (payload.customType ?? null) : null,
              timestamp,
              JSON.stringify(payload),
            ],
          );
          parentId = id;
        }

        await createLane(client, targetId, DEFAULT_LANE, parentId);
      });

      return openStorage(targetId);
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
node --test test-integration/session-storage-unit.test.mjs
```

预期：全部 29 个用例 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/infrastructure/postgres/session/repo.mjs test-integration/session-storage-unit.test.mjs
git commit -m "feat: implement postgres SessionRepo with fork"
```

---

### Task 9: conformance 全绿

前八个任务用的是本项目自己的窄测试。本任务面对 pi 官方的 30 个用例——它们会暴露前面测试没覆盖到的语义边界。

**Files:**
- Modify: 视失败情况修 `src/infrastructure/postgres/session/*.mjs`
- Modify: `package.json`（新增便捷脚本）

**Interfaces:**
- Consumes: Task 1–8 全部
- Produces: 无新接口，只有全绿的验收

- [ ] **Step 1: 跑完整套件，记录失败清单**

```bash
npm run db:up
node scripts/prepare-test-database.mjs
node --test test-integration/session-storage-conformance.test.mjs 2>&1 | tee /tmp/conformance.log
grep "^not ok" /tmp/conformance.log
```

把失败用例按 group 归类。预期集中在这几处：

- **validation and immutability** —— `rejects non-JSON entries before storage mutation`：`assertJsonSerializable` 必须在**任何写入之前**执行，包括在 `nextSeq` 之前，否则会消耗掉一个 seq。检查 `appendEntry` 的语句顺序。
- **queries and facts** —— 游标与 limit 的边界组合。
- **records and log** —— `does not let an earlier finish close a later start`：`findOpenOperations` 的 `NOT EXISTS` 必须同时比较 seq 顺序，而不只是 `run_id` 相等。

- [ ] **Step 2: 修 appendEntry 的校验顺序**

`entries.mjs` 中把 JSON 校验提到 `nextSeq` 之前（Task 3 的实现已如此，此步是验证）。若 conformance 仍报错，改为在函数第一行校验：

```js
export async function appendEntry(client, sessionId, provisioned, lane) {
  const { type, id, ...rest } = provisioned;
  // 必须先于任何写入与任何 seq 分配
  const payload = assertJsonSerializable(rest, `entry ${id}`);
  ...
}
```

- [ ] **Step 3: 修 findOpenOperations 的闭合判定**

若 `does not let an earlier finish close a later start` 失败，把 `NOT EXISTS` 子句加上 seq 约束：

```sql
AND NOT EXISTS (
  SELECT 1 FROM agent_session_records finished
   WHERE finished.session_id = started.session_id
     AND finished.type = 'operation_finished'
     AND finished.run_id = started.id
     AND finished.seq > started.seq
)
```

- [ ] **Step 4: 逐组跑到全绿**

```bash
node --test test-integration/session-storage-conformance.test.mjs 2>&1 | tail -20
```

预期：`# fail 0`，30 个用例全部 PASS。

**若某个用例暴露的语义与本计划的实现假设冲突，以 conformance 为准**——它是 pi 的契约定义，本计划的注释只是理解。

- [ ] **Step 5: 加便捷脚本**

`package.json` 的 `scripts` 增加：

```json
"test:session": "node scripts/prepare-test-database.mjs && node --test test-integration/session-storage-*.test.mjs"
```

- [ ] **Step 6: 跑全量测试确认无回归**

```bash
npm test
npm run test:integration
npm run check
```

预期：`npm test` 34 个用例仍全绿（本切片未碰 domain）；集成测试全绿；语法检查通过。

- [ ] **Step 7: 提交**

```bash
git add src/infrastructure/postgres/session/ package.json
git commit -m "test: pass pi session backend conformance suite"
```

---

### Task 10: 文档与切片收尾

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-20-pi-agent-migration-design.md`

**Interfaces:**
- Consumes: 无
- Produces: 无

- [ ] **Step 1: 更新 README**

在「目录」一节的 `src/infrastructure/postgres/` 行下补一行：

```text
src/infrastructure/postgres/session/  pi Agent 会话的 PostgreSQL 后端（SessionStorage + SessionRepo）
```

在「当前限制」一节把过期的测试数量改正，并新增一条：

```text
- Agent 会话轨迹已可持久化到 PostgreSQL，通过 pi 官方 conformance 套件 30 个用例；Agent 本身尚未接线（切片 2）。
```

同时把「19 个集成测试」改为实际数量（跑 `npm run test:integration` 取准确值）。

- [ ] **Step 2: 回填设计文档的两处修正**

在 `docs/superpowers/specs/2026-08-20-pi-agent-migration-design.md` §11.2 补一段：

```markdown
**实施修正（切片 1 完成后回填）：**

- 验收契约是 `SessionRepo`（create / open / list / delete / fork）+ `SessionStorage`（17 方法），
  不只是后者。`SessionBackendFixture` 要求 `readonly repository: SessionRepo`。
- 实际建 7 张表。sqlite 参考实现的 `branch_entries` / `branch_tips` 是派生缓存，
  PostgreSQL 用 `WITH RECURSIVE` 沿 parent_id 现算即可省掉；`writer_leases` 解决的是
  多进程抢 SQLite 文件，PostgreSQL 有真事务，同样不需要。
- `seq` 是全会话共享的单调序列，**每一次 mutation 消耗一个**——包括 createLane、
  moveLane、setName、setLabel，不只是 entries 与 records。
```

- [ ] **Step 3: 提交**

```bash
git add README.md docs/superpowers/specs/2026-08-20-pi-agent-migration-design.md
git commit -m "docs: record postgres session backend and spec corrections"
```

---

## 切片 1 完成标准

- [ ] `node --test test-integration/session-storage-conformance.test.mjs` → 30 个用例全绿
- [ ] `npm test` → 34 个用例全绿（domain 未受影响）
- [ ] `npm run test:integration` → 全绿
- [ ] `npm run check` → 通过
- [ ] `src/domain/**`、`src/api/**`、`src/worker/**` 未被修改（`git diff --stat` 确认）
- [ ] 无新增构建步骤，`package.json` 只多了 `@earendil-works/pi-agent-core@0.84.2`

## 下一步

切片 2（Agent 接线到真实生图）另起一份计划，开始前需要解决设计文档 §17 的 open 项：`RELAY_TEXT_MODEL` 的具体值——该模型必须同时支持 function calling 且 `input` 含 `'image'`。
