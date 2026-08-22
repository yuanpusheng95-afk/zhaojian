# 切片 2b：轮次数据模型与 Domain 锁上移 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把数据模型从「一次生图 = 一个队列任务」迁移到「一轮 Agent Turn = 一个队列任务」：新增 `agent_turns`、`generation_jobs` 瘦身改名 `generations` 并砍到二态、项目锁从 generation 上移到 turn、幂等离开 domain 进入 `agent_turns` 的唯一约束、repository 改造为「一次生图单事务落库」。结束后旧 Worker 与旧生图 API 按预期失效（2c/2d 重生）。

**Architecture:** 先拆除失效调用方（旧 Worker / 旧队列 / EditInterpreter）——它们 import 的 `GenerationLeaseLostError` 会在 repository 改造时消失，不先删就会出现红灯窗口；再摘除 domain 的锁与幂等、删除状态机（domain 与 repository 是两套独立实现，可独立保绿）；最后把迁移四份（006–009）、repository 改造、集成测试重写**合并为一个任务**，因为改表名不改 SQL 必红、改完 SQL 不改测试仍红，三者不可分割。repository 只保留 `createProject` / `recordGeneration`（单事务记录终态生图）/ `selectCandidate` / 读方法；调用方（Agent Tools，2c）在调 Provider **之前**用 domain 纯函数校验 patch，拿到结果后一次性落库。

**Tech Stack:** 无新增依赖。PostgreSQL 迁移 SQL、Node.js 22 原生 ESM、`node:test`。

**设计文档：** `docs/superpowers/specs/2026-08-20-pi-agent-migration-design.md` §7（数据模型变更）、§10.3（项目锁上移）、§12.1（repository 方法级改动）、§2.3（破坏清单）

**前置：** 切片 1 完成（conformance 30/30）；切片 2a 完成（探针、对象存储、ImagesProvider、telemetry 已提交）。本切片与 2a 零交集：不碰 `src/infrastructure/{models,storage,telemetry}`、不碰 `src/infrastructure/postgres/session/`、不碰 `scripts/`。

## Global Constraints

- Node.js `>=22`，不引入构建步骤，源码为 `.mjs`
- **`src/domain/photo-state.mjs` 与 `test/photo-state.test.mjs` 一行不改**——spec §18 硬验收线，git diff 必须为空
- 集成测试串行：`npm run test:integration` 已带 `--test-concurrency=1`，不得改回并行
- 迁移编号沿用序号规则，`migrations/005_agent_sessions.sql` 已被占用，本切片新增 006–009
- **迁移不携带存量数据迁移逻辑**（理由见「开发库策略」），因此迁移按「空表或可丢弃数据」编写
- 本切片结束前不新增 `agent-turn-queue`（那是 2c 的 `claimNextTurn` / `renewTurnLease` / `finishTurn` / `requestTurn`）；本切片只交付它们依赖的表和列
- **每个 Task 结束时 `npm test` 与 `npm run test:integration` 必须全绿，本切片没有计划内红灯窗口**；为此失效调用方在改 domain/repository **之前**删除（Task 1）

## 对设计文档的六处修正（实施前已核实，以本计划为准）

1. **`provider_jobs` 不是表，是列。** spec §7.3 写「删除 provider_jobs 表」，但 migrations 003/004 实际把 provider 信息做成了 `generation_jobs` 上的四列（`provider_name` / `provider_model` / `provider_job_id` / `provider_submitted_at`）加一个 CHECK（`generation_jobs_provider_job_complete`）和一个部分唯一索引（`generation_jobs_provider_job_unique_idx`）。没有独立表可删——处置并入 007 的逐列清算。

2. **`generations` 需要新增 `metadata_json` 列。** spec §5.2 说 `renderPrompt` 「仅记入 `generations.metadata_json` 供审计」、§7.3 说「审计信息记入 `generations.metadata_json`」，但 §7.2 的逐列清算表漏了这一列。007 必须补：`metadata_json jsonb NOT NULL DEFAULT '{}'`。

3. **repository 方法处置与 §12.1 的表述不同：`addCandidate` 与 `transitionGeneration` 不是「改」，是删除。** §3.4 的单事务时序（INSERT assets + generations + generation_outputs）与 §7.2 的「generation 创建即终态、没有转移」合起来意味着：generation 行只在拿到结果后写入一次，不存在先建后补的中间时刻。**`requestGeneration` 必须改名为 `recordGeneration`**：它不再「请求」任何东西，而是记录一次**已经完成**的生图。spec §7.2 为了「名字骗人的代价高于写迁移的代价」把 `generation_jobs` 改成了 `generations`——同一条原则必须一致适用，留一个语义已反转的方法名就是给下一个读代码的人埋雷。`recordProviderJob` 随 provider 列一起删除。

4. **迁移编号顺移。** spec §12 写的 005_agent_turns / 006–008 / 009_agent_sessions 与现实冲突（005 已是 agent_sessions）。本切片：`006_agent_turns.sql`、`007_generations.sql`、`008_projects_turns.sql`、`009_drop_legacy.sql`。

5. **domain 锁逻辑是 5 处，不是 4 处。** §10.3 列了 `requestGeneration` 的检查（168–170）与设置（202）、`selectCandidate` 的检查（273–276）、清锁（367–368），漏了 **`createProject` 里的 `runningGenerationId: null` 初始化（130 行）**。

6. **domain 单测改动量是 7 个，不是 §10.3 说的 2 个。** 逐例盘点 `test/project-workflow.test.mjs` 的 11 个用例（行号为当前文件实测）：

| 用例（行号） | 处置 | 理由 |
|---|---|---|
| creates a revision only after selection（87） | 保留断言，重写构造 | 最终断言（114–118 行）不变；构造路径换掉——`advanceToCompleted` helper（66–85 行，5 次 transitionGeneration + addCandidate）被删，改为单次带 outcome 的 recordGeneration；98 行 `status === 'queued'` 断言改 `'completed'`；46 行 anchorAssetId 机械改 anchorAsset 对象 |
| returns the original generation for the same idempotency key（121） | **删除** | 幂等离开 domain，由 `agent_turns` 唯一约束承担（§7.5），2c/2d 验收 |
| rejects a new generation while another is active（138） | **重写** | ProjectBusyError 消失 → 改为「一轮内连续两次 recordGeneration 都成功」（重 roll 在 domain 层的直接表达） |
| rejects an edit based on a stale revision（161） | 保留 | 仅 requestGeneration 调用点换 recordGeneration 新签名（去 idempotencyKey、补 turnId/outcome），断言不变 |
| rejects status jumps（177） | **删除** | 状态机删除，generation 创建即终态 |
| selecting same candidate idempotent / another rejected（197） | 保留断言，重写构造 | 「同 candidate 幂等 / 异 candidate 拒绝」保留；但旧构造给一个 generation 塞两个 candidate（215–226 行）——MVP 一次生图一候选（§5.2），该前提不复存在。「异 candidate 拒绝」改用不存在的 candidateId 表达（仍命中 already-selected 分支） |
| rejects reusing an idempotency key for a different request（252） | **删除** | 同 121 |
| releases the project lock when a generation fails（278） | **删除** | domain 不再持有锁 |
| older completed generation cannot change active revision（301） | **重写** | ProjectBusyError 消失 → 改为断言 `RevisionConflictError`（stale inputRevision 保护仍然存在） |
| requires an idempotency key（330） | **删除** | 参数已不存在 |
| rejects invalid initial photo state（345） | 保留 | 语义不变 |

   结果：4 保留（断言语义不变；其中 2 个重写构造路径、1 个仅签名适配、1 个原样）、2 重写、5 删除，另有新增用例（见 Task 2）。

## 开发库策略（Task 3 第一步执行）

实测开发库 `photo_agent`：只应用过 001–004（**连 005 都没跑**），数据是冒烟残留（2 projects / 1 generation_job / 3 revisions / 1 idempotency_request）。它是过期的一次性数据。

**决定：迁移按空表编写，开发库一次性重建，不写任何 backfill。** 理由：产品未上线、无真实数据、无第二个环境；为不存在的数据写迁移代码只会给将来的读者制造「这里有数据要保护」的错觉。`NOT NULL` 的新列（`turn_id`、`input_asset_id`）在有空行时必然失败，这不是迁移的 bug，是策略的边界——边界由重建程序兜住。

重建命令（只动数据库，不动 volume）：

```bash
docker exec zhaojian-photo-agent-postgres-1 psql -U photo_agent -d postgres \
  -c "DROP DATABASE photo_agent;" -c "CREATE DATABASE photo_agent OWNER photo_agent;"
npm run db:migrate
```

集成测试不受影响：`photo_agent_test` 每个用例 `DROP SCHEMA` + 重跑迁移，天然从零开始。

## 核心语义（实现前必须理解）

**Generation 行只写一次，写入即终态。** 新时序（spec §3.4）：

```text
generate_image({ patch, renderPrompt })
  1. 读 revision → applyPhotoStatePatch(revision.state, patch)   ← 校验先于花钱，失败抛错给模型自纠
  2. imagesModels.generateImages(...)                             ← 30–90s，唯一花钱的调用
  3. 字节 PUT 对象存储 → uri
  4. 单事务：INSERT assets + generations(终态) + generation_outputs
```

步骤 1 是 domain 纯函数调用（tool 直接 `import { applyPhotoStatePatch }`），不经过 repository；步骤 4 是 `recordGeneration` 的全部职责。repository 内部仍做一次 patch 校验（防御性双保险，与现状 `photo-project-repository.mjs:142` 同理），但**不存在**「先创建 queued 行、等结果、再转移」的路径——那正是被删除的世界。

**幂等离开 domain。** 去重与冲突检测由 `agent_turns` 的 `UNIQUE (project_id, idempotency_key)` 承担，指纹就是 `user_message`（§7.5）。本切片只建表；`requestTurn` 的 `ON CONFLICT` 三态逻辑是 2c 的活。**后果：generation 层面同条件重 roll 必须成功**——这就是删掉 `UNIQUE (project_id, idempotency_key)` 的原因，也是 Task 3 最重要的验收用例。

**锁的粒度上移，domain 不再持有锁。** `photo-project-service.mjs` **五处**锁逻辑全部摘除：`createProject` 的初始化（130 行）、`recordGeneration` 的检查（168–170 行）与设置（202 行）、`selectCandidate` 的检查（273–276 行）、`#releaseProjectGeneration`（367–368 行）。互斥的新归属是 `projects.running_turn_id` + `FOR UPDATE SKIP LOCKED`，由 2c 的队列在领取/释放轮次时维护。本切片只交付 `running_turn_id` 列。

**`inputRevisionId` 与 `inputAssetId` 是两个概念。** 前者只表示「patch 基于哪个 Revision 的状态计算」，在一轮内不随生图推进；后者是实际喂给图像模型的基准图，第一次生图 = Revision 锚定图，之后 = 上一张候选（§5.7 的指针推进，由 2c 的轮次上下文维护）。

**RevisionConflict 检查保留。** `recordGeneration` 与 `selectCandidate` 里 `activeRevisionId` 的一致性检查是数据完整性守护，与锁无关，原样保留。

## File Structure

```text
migrations/006_agent_turns.sql              agent_turns 表 + 队列索引
migrations/007_generations.sql             改名 + 逐列清算 + 约束/索引改名
migrations/008_projects_turns.sql          running_turn_id + owner_id
migrations/009_drop_legacy.sql             删除 idempotency_requests

src/domain/generation-lifecycle.mjs        GENERATION_TRANSITIONS 删除；TERMINAL/SELECTABLE 砍到二态（Task 3，随 repository 重写）
src/domain/photo-project-service.mjs       锁/幂等/状态机摘除；requestGeneration → recordGeneration（Task 2）
src/infrastructure/postgres/photo-project-repository.mjs
                                           createProject 补 owner/uri；recordGeneration 单事务记录；
                                           selectCandidate 去锁；删 transitionGeneration/recordProviderJob/addCandidate

test/project-workflow.test.mjs             4 保留 / 2 重写 / 5 删除 / 新增 2（Task 2）
test-integration/postgres-repository.test.mjs   接近重写（22 例 → 新套件，含重 roll 验收）

删除（Task 1，先于 domain/repository 动手——理由见该任务）：
src/application/edit-interpreter.mjs
src/application/mock-language-model.mjs
src/infrastructure/postgres/generation-queue.mjs
src/worker/generation-worker.mjs
src/worker/mock-image-provider.mjs
src/worker/main.mjs                       （2c 以 agent-turn-worker 之名重生）
test/edit-interpreter.test.mjs
test/generation-worker.test.mjs
```

修改但不大动：`src/api/server.mjs`（删 POST `/projects/:id/generations` 路由，其余保留到 2d）、`package.json`（临时摘除 `start:worker`）、`README.md`（闭环描述与当前限制同步）。

不修改：`src/domain/photo-state.mjs`、`src/api/main.mjs`、`src/infrastructure/postgres/session/**`、`src/infrastructure/{models,storage,telemetry}/**`、`scripts/**`、`compose.yaml`。

## 既有约束名清单（007/008 改名时逐一对照，防漏）

实测开发库（与 001–004 一致）：

```text
generation_jobs 上的外键：
  generation_jobs_project_id_fkey          → generations_project_id_fkey
  generation_jobs_input_revision_id_fkey   → generations_input_revision_id_fkey
  generation_jobs_selected_candidate_fk    → generations_selected_candidate_fk
  generation_jobs_selected_revision_fk     → generations_selected_revision_fk
指向 generation_jobs 的外键（RENAME TO 自动携带，无需操作）：
  generation_outputs_generation_id_fkey    → 保留（generation_id 是列名，不含旧表名）
  photo_revisions_source_generation_fk     → 保留（同上）
  idempotency_requests_generation_id_fkey  → 无需操作（009 随表删除）
  projects_running_generation_fk           → 008 直接 DROP（列一起删）

改名规则：**只改名字里含旧表名 `generation_jobs` 的对象。** 含 `generation_id`（列名）的不动——
否则就是无谓改动，且与本清单自己的规则矛盾。
索引与主键：
  generation_jobs_pkey                     → RENAME generations_pkey（主键索引同样带旧名，最易漏）
  generation_jobs_queue_idx                → DROP（不再是队列）
  generation_jobs_active_lease_idx         → DROP（引用 lease 列，随列删除自动清理）
  generation_jobs_project_created_idx      → RENAME generations_project_created_idx
检查/唯一：
  generation_jobs_status_check             → 重建为 generations_status_check（二态）
  UNIQUE (project_id, idempotency_key)     → 随 idempotency_key 列删除自动清理
  generation_jobs_provider_job_complete    → 随 provider 列删除自动清理
  generation_jobs_provider_job_unique_idx  → 随 provider 列删除自动清理
  generation_jobs_attempt_count_check      → 随 attempt_count 列删除自动清理
```

---

### Task 1: 删除失效调用方（先拆脚手架，再改承重墙）

**为什么这一步必须在 domain/repository 之前：** 这些文件调用的接口在后续任务里改形。实测依赖链：`test/generation-worker.test.mjs:4` 与 `src/infrastructure/postgres/generation-queue.mjs:3` 都 import `GenerationLeaseLostError`（Task 3 会从 repository 删除该导出）——若不先删调用方，repository 改形的瞬间 `npm test` 就会挂掉，违反「每个 Task 结束全绿」的约束。先删调用方，后续改造全程绿灯。

这些代码本来就在 2b 的死刑名单上（spec §2.3「会破坏且已接受」+ §12 删除清单）：它们构成的「固定工作流」正是本次迁移要替换的东西。

**Files:**
- Delete: `src/application/edit-interpreter.mjs`、`src/application/mock-language-model.mjs`（目录随之删除）
- Delete: `src/infrastructure/postgres/generation-queue.mjs`
- Delete: `src/worker/generation-worker.mjs`、`src/worker/mock-image-provider.mjs`、`src/worker/main.mjs`（目录删除）
- Delete: `test/edit-interpreter.test.mjs`（12 例）、`test/generation-worker.test.mjs`（5 例）
- Modify: `package.json`——摘除 `start:worker`（2c 以 agent-turn-worker 恢复）

- [ ] **Step 1: 逐项删除**，`npm run check` 通过
- [ ] **Step 2: 验证**

```bash
npm test    # 剩余 photo-state(6) + project-workflow(11 旧版) 全绿——domain 还没动
npm run test:integration   # 仍全绿——schema 未动，repository 未动
```

---

### Task 2: domain——锁上移、幂等摘除、状态机删除

**本任务全程绿灯。** domain（纯内存 `PhotoProjectService`）与 repository（SQL 实现）是两套独立实现，只共享 `applyPhotoStatePatch`；集成测试走 repository，此刻 schema 未动，因此不受影响。

单测先行：先改测试表达新语义，再改实现让它们变绿。

**Files:**
- Modify: `src/domain/photo-project-service.mjs`
- Modify: `test/project-workflow.test.mjs`

**Interfaces（Produces）:**
- **`generation-lifecycle.mjs` 本任务一行不动，重写挪到 Task 3。** 两个理由：其一，`photo-project-repository.mjs:13–17` 此刻仍在 import `GENERATION_TRANSITIONS`——Node ESM 对不存在的命名导出在**链接期**抛 SyntaxError，本任务删除它会让集成套件当场崩，违反「无红灯窗口」；其二，连**值**也不能先改——旧集成套件的仓库路径仍依赖旧值集（`partial_failed` 在旧状态机可达，`TERMINAL` 提前瘦身可能改变旧 lock-release 行为）。新 domain 代码不需要新值：`recordGeneration` 直接产出 completed/failed，旧 `SELECTABLE_GENERATION_STATUSES`（含 `partial_failed`）对新 domain 行为等价——`partial_failed` 在新路径下不可构造。终态版本（`TERMINAL = {completed, failed}`、`SELECTABLE = {completed}`、`GENERATION_TRANSITIONS` 删除）随 Task 3 的 repository 重写一并落地
- `PhotoProjectService`：
  - `createProject({ projectId, name, initialState, anchorAsset = null })`——`anchorAsset` 从 `anchorAssetId: string` 变为 `{ assetId, uri = null, contentType = null } | null`（与 repository 对齐，revision 的 `anchorAssetId` 字段不变）
  - `recordGeneration({ projectId, turnId, baseRevisionId, inputAssetId, patch, renderPrompt = null, outcome })`——`turnId` 非空校验；`outcome` 为 `{ kind: 'completed', candidate: { assetId, uri = null, contentType = null } }` 或 `{ kind: 'failed', error }`；校验 revision 一致性与 patch，创建**终态** generation；不设锁、不看锁、无幂等。`inputAssetId` 是逻辑基准图 ID：无论成功或失败都必须已存在于 assets，Provider 提前失败也不例外
  - `selectCandidate({ projectId, generationId, candidateId })`——签名不变；删除 ProjectBusy 检查；「同 candidate 幂等返回 / 异 candidate 拒绝」保留
  - 删除：`requestGeneration`（改名 `recordGeneration`）、`transitionGeneration`、`addCandidate`、`#idempotency`、`#releaseProjectGeneration`
  - **暂留：`IdempotencyConflictError`、`ProjectBusyError`、`GenerationTransitionError`、`InvalidGenerationRequestError` 继续导出**——`photo-project-repository.mjs` 此刻仍在 import 它们（3–12 行），本任务删除会打断集成套件的 import 链，违反「无红灯窗口」约束。domain 本任务起不再**抛出**它们；四个类在 Task 3 重写 repository 时随之删除（最后一个 import 方消失的时刻）
  - generation 对象新增 `turnId` / `inputAssetId` / `renderPrompt` 字段，删除 `operation` / `idempotencyKey` 字段

- [ ] **Step 1: 按「对设计文档的六处修正」第 6 条的表改 `test/project-workflow.test.mjs`**——5 删、2 重写。保留用例的三类改动：46 行 `anchorAssetId: 'asset_source'` 机械改为 `anchorAsset: { assetId: 'asset_source' }`；`advanceToCompleted` helper（66–85 行）替换为新 helper（单次 `recordGeneration` 带 `outcome: { kind: 'completed', candidate }`，返回 generation），87 号用例 98 行 `status === 'queued'` 断言改 `'completed'`；197 号用例按修正表去掉单 generation 双候选构造。新增两例：

```js
// 新增 1：重 roll 的 domain 表达
test('allows a second generation with an identical patch in the same turn', () => {
  // 同 turnId、同 baseRevisionId、同 patch 连续 recordGeneration 两次
  // 断言：两次都成功、generationId 不同、互不干扰
});

// 新增 2：失败生图的记录路径
test('records a failed generation without candidates', () => {
  // outcome { kind: 'failed', error } → status 'failed'、无 candidates
});
```

重写的两例（138 → 并入上方新增 1；301 → 断言 `RevisionConflictError`）。改完跑 `npm test`——**新断言应红**。

- [ ] **Step 2: 改 `photo-project-service.mjs`**——按 Interfaces 清单摘除与重写。**锁逻辑共 5 处：130（createProject 初始化）、168–170、202、273–276、367–368。** 注意 `selectCandidate` 中 `SELECTABLE_GENERATION_STATUSES` 检查保留（沿用旧值集，理由见 Interfaces），`inputRevisionId` 一致性检查保留

- [ ] **Step 3: 验证**

```bash
npm test                 # project-workflow 新套件全绿；photo-state 6 例不动
git diff --stat src/domain/photo-state.mjs test/photo-state.test.mjs   # 必须为空
```

---

### Task 3: schema 迁移、repository 改造与集成测试重写

**三者合并，因为不可分割**：改表名不改 SQL 必红，改完 SQL 不改测试仍红。拆开会让集成套件连续多个任务处于红灯，届时无法区分「预期的红」与「新引入的破坏」——切片 1 正是靠周围全绿才在几秒内定位到并发 bug。

本任务较大，内部按 schema → repository → 测试推进，**只在最后一次性验收**。

**Files:**
- Create: `migrations/006_agent_turns.sql`、`007_generations.sql`、`008_projects_turns.sql`、`009_drop_legacy.sql`
- Modify: `src/domain/generation-lifecycle.mjs`（Task 2 暂留的终态化在此落地）
- Modify: `src/infrastructure/postgres/photo-project-repository.mjs`
- Modify: `test-integration/postgres-repository.test.mjs`（22 例 → 新套件）

**Consumes:** Task 2 的 domain 导出。
**Interfaces：** `agent_turns` 是 2c `agent-turn-queue.mjs` 的依赖，列定义严格按 spec §7.1（**没有 `attempt_count`**——上限 1 的重试用计数器表达布尔事实，是误导）。

**Interfaces（Produces）:**
- `createProject({ projectId, name, initialState, anchorAsset = null, ownerId = 'dev' })`——assets 插入补写 `uri` 与 `metadata_json`（**列在 001 就存在，只是从未被写过**——这是 §6.3 指出的断点）；projects 插入补 `owner_id`、去掉 `running_generation_id`
- `recordGeneration`——签名与语义同 Task 2 的 domain 版本（含 `turnId` 非空校验）；单事务内：锁行 project（`FOR UPDATE`，只为一致读，不做 busy 检查）→ 校验 turn 存在且属于该 project（返回稳定的领域错误，不让 FK 冲突穿透）→ 校验 inputAsset 已存在 → revision 一致性 → patch 双重校验 → `INSERT assets`（candidate，含 uri/metadata）→ `INSERT generations`（终态、`input_asset_id`、`turn_id`、`metadata_json.renderPrompt`）→ completed 时 `INSERT generation_outputs` → 返回映射结果。失败路径同样要求 `inputAssetId` 指向已有逻辑基准图
- `selectCandidate`——删除 `runningGenerationId` 检查（358–363 行），其余原样；表名换 `generations`
- 删除：`transitionGeneration`、`recordProviderJob`、`addCandidate`、`GenerationLeaseLostError`、`ProviderJobConflictError`、`requireLease`、`requestFingerprint`、`sortObject`，以及 Task 2 暂留的四个 domain 错误类（`IdempotencyConflictError` / `ProjectBusyError` / `GenerationTransitionError` / `InvalidGenerationRequestError`）——repository 是它们最后的 import 方，重写后从 domain 一并删除
- 映射层：`mapProject` 的 `runningGenerationId` → `runningTurnId`、补 `ownerId`；`mapGeneration` 补 `turnId` / `inputAssetId` / `renderPrompt`，删 `operation` / `idempotencyKey` / lease / provider 投影；所有 `generation_jobs` SQL 换 `generations`

- [ ] **Step 1: 重建开发库**（命令见「开发库策略」），确认 `db:migrate` 后 `schema_migrations` 有 001–009

- [ ] **Step 2: `006_agent_turns.sql`**

```sql
CREATE TABLE agent_turns (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  user_message text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','completed','failed','aborted')),
  lease_token text,
  lease_expires_at timestamptz,
  outcome_json jsonb,
  error_json jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (project_id, idempotency_key)
);

CREATE INDEX agent_turns_queue_idx ON agent_turns(status, created_at, id);
CREATE INDEX agent_turns_project_created_idx ON agent_turns(project_id, created_at, id);
```

- [ ] **Step 3: `007_generations.sql`**（逐列清算，对照上方约束名清单）

```sql
ALTER TABLE generation_jobs RENAME TO generations;

-- 新列：renderPrompt 审计归宿 + 输入图 + 归属轮次
ALTER TABLE generations
  ADD COLUMN input_asset_id text NOT NULL REFERENCES assets(id),
  ADD COLUMN turn_id text NOT NULL REFERENCES agent_turns(id),
  ADD COLUMN metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 删列：幂等（作用域移至 agent_turns）、operation（恒 'edit' 的遗留）、lease、provider。
-- 下列对象引用了被删列，PostgreSQL 随列删除自动清理，**不要再显式 DROP**（会报 does not exist）：
--   generation_jobs_project_id_idempotency_key_key（UNIQUE，实测自动名）
--   generation_jobs_provider_job_complete（CHECK）
--   generation_jobs_provider_job_unique_idx（部分唯一索引）
--   generation_jobs_active_lease_idx（部分索引，含 lease_expires_at）
--   generation_jobs_attempt_count_check（CHECK）
ALTER TABLE generations
  DROP COLUMN idempotency_key,
  DROP COLUMN operation,
  DROP COLUMN claim_token,
  DROP COLUMN claimed_at,
  DROP COLUMN lease_expires_at,
  DROP COLUMN attempt_count,
  DROP COLUMN provider_name,
  DROP COLUMN provider_model,
  DROP COLUMN provider_job_id,
  DROP COLUMN provider_submitted_at;

-- 显式处置的两个：引用的列（status/created_at）都保留，不会被自动清理
ALTER TABLE generations DROP CONSTRAINT generation_jobs_status_check;
DROP INDEX generation_jobs_queue_idx;

ALTER TABLE generations
  ADD CONSTRAINT generations_status_check CHECK (status IN ('completed','failed'));

-- 改名：RENAME TO 不改约束/索引名，逐条显式改（实测名见上方清单；RENAME CONSTRAINT 需 PG 12+）
ALTER TABLE generations RENAME CONSTRAINT generation_jobs_pkey TO generations_pkey;
ALTER TABLE generations RENAME CONSTRAINT generation_jobs_project_id_fkey TO generations_project_id_fkey;
ALTER TABLE generations RENAME CONSTRAINT generation_jobs_input_revision_id_fkey TO generations_input_revision_id_fkey;
ALTER TABLE generations RENAME CONSTRAINT generation_jobs_selected_candidate_fk TO generations_selected_candidate_fk;
ALTER TABLE generations RENAME CONSTRAINT generation_jobs_selected_revision_fk TO generations_selected_revision_fk;
-- generation_outputs_generation_id_fkey / photo_revisions_source_generation_fk：
-- 名字里是列名不是旧表名，RENAME TO 已自动重指向 generations，不操作
ALTER INDEX generation_jobs_project_created_idx RENAME TO generations_project_created_idx;
```

- [ ] **Step 4: `008_projects_turns.sql`**

```sql
ALTER TABLE projects DROP CONSTRAINT projects_running_generation_fk;
ALTER TABLE projects DROP COLUMN running_generation_id;
ALTER TABLE projects ADD COLUMN running_turn_id text REFERENCES agent_turns(id);
ALTER TABLE projects ADD COLUMN owner_id text NOT NULL DEFAULT 'dev';
```

- [ ] **Step 5: `009_drop_legacy.sql`**

```sql
DROP TABLE idempotency_requests;
```

- [ ] **Step 6: 重写 repository 与 `generation-lifecycle.mjs`**——repository 635 行预计减到 ~420 行（`#transaction` / `#require*` 辅助不动）；lifecycle 砍到二值集（`GENERATION_TRANSITIONS` 删除——此刻它的最后一个 import 方正随 repository 重写消失）。同时新增 `TurnNotFoundError`（domain 定义并导出，repo 的 turn 前置校验与 2c 的队列共用）。`npm run check` 语法过

- [ ] **Step 7: 重写集成测试**——沿用既有夹具（模块级 pool、`resetDatabase` 护栏、`after` 关池）。用例清单：

```text
1.  migration creates the turn schema            表清单 + 关键约束存在性
      （agent_turns 唯一约束、generations 二态 CHECK、running_turn_id FK、owner_id 默认 'dev'）
2.  createProject writes owner and anchor asset uri/metadata
3.  createProject defaults owner to 'dev'
4.  recordGeneration records a completed generation in one transaction
      （asset.uri 非空、output 行存在、status='completed'、turn_id/input_asset_id 正确）
5.  recordGeneration records a failed generation with error json
      （inputAssetId 也必须指向已有逻辑基准图）
6.  recordGeneration rejects a stale base revision           RevisionConflict
7.  recordGeneration rejects a missing or foreign turn       TurnNotFoundError
8.  recordGeneration rejects an invalid patch                domain 校验穿透
9.  ★ re-roll: identical patch twice in one turn succeeds twice
      （同 turnId + 同 patch 两次调用 → 两条 generation 均成功。这是删除
        UNIQUE (project_id, idempotency_key) 的显式验收——spec §18 要求它存在）
10. selectCandidate switches the active revision atomically
11. selectCandidate is idempotent for the same candidate
12. selectCandidate rejects a different candidate after selection
13. selectCandidate rejects a stale input revision            RevisionConflict
14. selectCandidate rejects cross-project generation
15. foreign keys reject deleting a project that still has turns
      （**实测 projects/revisions/generations/outputs 域的 14 个外键均为 NO ACTION，
        无 ON DELETE CASCADE**——session 表的 CASCADE 属于 agent_sessions 域，与删除
        project 无关。原「级联删除」断言的是不存在的行为，会直接跑挂。产品也没有删除
        project 的端点——改为断言外键守护确实生效）
16. listGenerations / listRevisions / get* 投影包含新字段、不含已删字段
```

- [ ] **Step 8: 一次性验收**

```bash
npm run db:migrate
npm test                    # domain 套件保持 Task 2 的绿
npm run test:integration    # repository 新套件 + session 30 例 + asset-storage 全绿
```


---

### Task 4: API 收尾

**Files:**
- Modify: `src/api/server.mjs`——两处：
  1. 删 POST `/projects/:id/generations` 路由（handler 调用已删的 `requestGeneration`）
  2. **清理 `mapError` 里的四个死错误码**：`IDEMPOTENCY_CONFLICT`、`PROJECT_BUSY`、`INVALID_GENERATION_TRANSITION`（133–136 行，409 段）与 `INVALID_GENERATION_REQUEST`（约 146 行，400 段）——对应 Error 类已在 Task 3 随 repository 重写删除，留着是让错误映射说谎
- Modify: `README.md`——「已实现闭环」改为迁移中间态描述（生图入口 2d 以 `POST /projects/:id/messages` 回归）

- [ ] **Step 1: 改 server.mjs 与 README**，`npm run check` 通过
- [ ] **Step 2: 残留扫描**

```bash
rg -n 'generation_jobs|idempotency_requests|running_generation_id|EditInterpreter|recordProviderJob|transitionGeneration|addCandidate|ProjectBusy|IDEMPOTENCY_CONFLICT|INVALID_GENERATION_TRANSITION|INVALID_GENERATION_REQUEST|requestGeneration|GENERATION_TRANSITIONS' src/ test/ test-integration/ scripts/
# 预期：零命中（docs/ 与 migrations/ 不在扫描路径内，无需排除）
```

- [ ] **Step 3: 全量验证**

```bash
npm test && npm run test:integration && npm run check
```

---

## 切片 2b 完成标准

- `npm test` 与 `npm run test:integration` 全绿
- **重 roll 用例存在且绿**（Task 3 用例 9）——旧唯一约束确已删除的最直接证据
- `git diff` 确认 `src/domain/photo-state.mjs` 与 `test/photo-state.test.mjs` 零改动
- Task 4 的残留扫描零命中
- `npm run start:worker` 不可用（预期，2c 恢复）；API 仅存 `/projects`、`GET /projects/:id`、`GET /generations/:id`、selections、`/health`
- 开发库已按 006–009 重建并可通过 `npm run db:migrate` 从零复现
- **每个 Task 结束时 `npm test` 与 `npm run test:integration` 都必须绿**——本切片没有计划内的红灯窗口
- 外键守护用例（Task 3 用例 15）断言的是「删除被拒绝」，不是级联删除——实测 projects 域 14 个外键均为 NO ACTION
- 2a 的四个交付（探针、对象存储、ImagesProvider、telemetry）零改动、测试零回归

## 下一步

切片 2c：`agent-turn-queue.mjs`（`requestTurn` 的 `ON CONFLICT` 三态 + `claimNextTurn` / `renewTurnLease` / `finishTurn`，**不照抄旧队列的重领重试逻辑**，§2.3）、`src/agent/`（tools、system prompt、turn-context、harness-factory）、Worker 进程内并发重写。本切片交付的 `agent_turns` 表与 `running_turn_id` 列是它的直接地基。
