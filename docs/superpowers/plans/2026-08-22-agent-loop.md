# 切片 2c：Agent 循环、Turn 队列与 Worker 并发 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打通「用户消息 → Worker 领取 Turn → Agent 调工具（读状态 / 生图 / 看图自评 / 选择）→ 轨迹入 PostgreSQL → Turn 终态」。交付 `agent-turn-queue`（一轮只尝试一次，无重领）、三个 Agent tools、system prompt、Agent 运行桥、进程内并发的 Worker。

**Architecture:** 用 pi 0.84.2 **实际可用的**原语组装：`Session`（挂切片 1 的 Postgres 后端）+ `buildSessionContext()`（轨迹 → Agent 上下文）+ `Agent`（带 `StreamFn` 的真实循环）+ 本项目薄编排层（session 回写、turn 收尾）。**不使用 `AgentHarness`——它在 0.84.2 是空壳**（见修正 1）。队列语义按 §8.2：领取即 running + lease，过期直接 failed，**不重领不重试**。

**Tech Stack:** `@earendil-works/pi-agent-core@0.84.2`（`Agent`、`Session`、`buildSessionContext`）、`@earendil-works/pi-ai@0.84.2`（`StreamFn` 类型、typebox）、`pg`、`node:test`。无新增依赖。

**设计文档：** `docs/superpowers/specs/2026-08-20-pi-agent-migration-design.md` §3（进程边界）、§5（Tools 契约）、§5.8（system prompt）、§8（一轮只尝试一次）、§9（错误处理与护栏）、§10（并发与超时）、§11.3（三层可观测性）、§14（fake StreamFn）

**前置：**
- 切片 2a 完成（供应商探针、S3 存储、relay ImagesProvider、stdout telemetry）
- 切片 2b 完成（agent_turns 表、generations 二态、recordGeneration 单事务、锁上移）——**当前 2b 改动尚未提交，先按惯例提交再开工本切片**
- `LLM_API_KEY`（DeepSeek）可用——**Task 1 的硬前提**；没有它本切片在 Task 1 停住，这是设计文档 §17 的头号 assumption，越早撞越好

## Global Constraints

- Node.js `>=22`，不引入构建步骤，源码为 `.mjs`
- pi 锁定 0.84.2；发现 API 缺口时**优先组合已有原语，不 fork、不自研 LLM 循环**
- **本切片不修改** `src/domain/**`（2b 刚定稿，工具是它的薄适配层）、`migrations/**`、`src/api/**`（API 重写是 2d）、session 后端（`src/infrastructure/postgres/session/**`）
- 集成测试串行（`--test-concurrency=1` 惯例）；真实模型调用**只出现在手动脚本，不进 CI**
- 每个任务结束 `npm test` 与 `npm run test:integration` 必须全绿（新增测试文件串行排队即可）
- Worker 的 stdout 只输出结构化 telemetry（§12.3），人类可读日志走 stderr

## 对设计文档的五处修正（实施前已核实，以本计划为准）

1. **§3.3 的 `AgentHarness` 在 0.84.2 不可用。** 实测 `dist/harness/agent-harness.js`：`prompt()`、`abort()`、`runToCompletion()`、`steer()` 等全部运行方法一律 `return this.unavailable(...)` 拒绝（`HarnessNotImplemented`），只有 getter/setter 与 `AgentHarness.create()`（且 create 在 session 已有 record 时直接抛"restore 未实现"）是活的。**它是 API 骨架，不是运行时。** §3.3 的三个理由（session 注入、resources、lane 控制）在源码里的落点其实是拆开的三样东西：`Session` 类（session 读写）、`Agent` 类（真实循环：transcript、工具执行、`shouldStopAfterTurn` 早停、steering）、`buildSessionContext()`（轨迹→上下文桥，`dist/harness/session/context.d.ts`）。**§2.2「不自研 agent 循环」仍然成立**——循环是 pi 的 `Agent`；自研的只是 harness 本应提供的薄编排（session 回写、turn 收尾），约 150–250 行。
2. **§4 的配置变量已演进**（2a 落地于 `src/config.mjs`，以现状为准）：`RELAY_*` 三兄弟不存在；现实是 `LLM_BASE_URL`（默认 `https://api.deepseek.com`）/ `LLM_API_KEY` / `LLM_MODEL`（默认 `deepseek-v4-flash-vision-exp`）与 `IMAGE_BASE_URL` / `IMAGE_API_KEY` / `IMAGE_MODEL` / `IMAGE_SIZE` / `IMAGE_EDIT_ROUTE`。§12.3 的 `TURN_LEASE_MS` / `TURN_HEARTBEAT_MS` / `WORKER_CONCURRENCY` / `SHUTDOWN_GRACE_MS` / `WORKER_POLL_INTERVAL_MS` 由本切片补进 `loadWorkerConfig`；`MAX_IMAGES_PER_TURN` / `IMAGE_TIMEOUT_MS` / `TURN_TIMEOUT_MS` 已存在。
3. **§17 头号 assumption 至今零实跑。** `scripts/probe-providers.mjs` 里的 `probeChat()`（带图输入返回 tool_calls）**写了但从未运行**——提交历史只记录了图像侧发现（`d316a1c`）。且 `llm-provider.mjs` 的 `input: ['text', 'image']` 是**手写声明不是验证过的事实**。Task 1 必须先把它变成事实，解析与接线代码照样本写（2a 的教训：从接口签名反推语义，返工一轮）。
4. **图像 img2img 走 chat 路由**（2a 实测 `/images/edits` 恒 502，`IMAGE_EDIT_ROUTE` 控制）。对 2c 的含义：`generate_image` 给模型的 `ImageContent` 输出格式与 renderPrompt 的组装已被 `relay-images-provider.mjs` 吸收，工具层不需要知道路由细节——但 system prompt 里的 renderPrompt 指引（§5.8）要按"chat 路由对超长指令更敏感"的实测定调，样本见 Task 1。
5. **§12 的 file layout 有两处改名**：`harness-factory.mjs` → `agent-runner.mjs`（harness 不存在，名字不能骗人）；`src/worker/` 从空目录重建。其余按设计文档。

## 核心语义（实现前必须理解）

**一轮的生命周期（§3.4 时序的 2c 落地版）：**

```text
[2d 的 API]  POST /projects/:id/messages → requestTurn()        （本切片只交付函数）
Worker 主循环（进程内最多 WORKER_CONCURRENCY 个在途轮）
 1. claimNextTurn()   FOR UPDATE SKIP LOCKED 领 queued → running + lease_token
 2. 心跳启动（TURN_HEARTBEAT_MS 间隔 renewTurnLease，覆盖整轮）
 3. AbortController（TURN_TIMEOUT_MS 整轮上限）
 4. 打开 Session（per project：repo.openOrCreate(project:projectId)）
    session.appendMessage(userMessage)          ← 用户消息先落轨迹
 5. buildSessionContext(分支 entries) → messages / activeToolNames
 6. new Agent({ streamFn, initialState: { messages }, tools 三件套, ... })
 7. agent.prompt(userMessage) → 事件流：
       assistant / toolCall / toolResult → session 回写（appendMessage / appendCustomEntry）
       generate_image 内部：校验 patch → 生图 → PUT S3 → repository.recordGeneration()
 8. RunOutcome 映射：completed / aborted(超时) / failed + 轮次上下文 fatal 标记
 9. finishTurn() 单事务：UPDATE agent_turns(status, outcome_json, error_json)
                      + UPDATE projects.running_turn_id = NULL
10. 停心跳
```

**一轮只尝试一次（§8.2）。** `claimNextTurn` 只领 `status='queued'`；发现 `running` 且 lease 过期（原 Worker 崩溃）时**不重领**，单事务置 `failed` + 释放项目锁 + 写 `error_json`。没有 attempt_count（2b 已定），没有重试循环。Lease 防的是旧实例继续写库，不撤销已发出的 Provider 调用（§17 已接受）。

**工具三件套的边界（§5.5）：工具是薄适配层**，typebox schema 声明 + 调 domain/repository + 转 `AgentToolResult`。业务规则（patch 白名单校验、Revision 冲突、selectCandidate 幂等）全部留在 2b 刚定稿的代码里，一行不搬。`AgentToolResult.terminate` 在 0.84.2 的 `Agent` 层真实存在（`dist/types.d.ts` 实测），`select_candidate` 用它结束循环；但 **terminate 只是尽早停止的优化**，终态判定以轮次上下文的 fatal 标记为准（§9.2——批内混合终止的坑）。

**基准图指针在轮次上下文（§5.7）：** 轮开始 = Revision 锚定图；`generate_image` 成功后推进到本候选；`select_candidate` 后本轮结束。Agent 不能指定输入图。成本护栏 `imageCount >= MAX_IMAGES_PER_TURN` 在工具内抛错（§9.3，可纠正错误 → 模型转向选图）。

**可纠正错误抛异常，不可纠正错误走 terminate + fatal（§9.1）。** patch 校验失败 / candidateId 不存在 / REVISION_CONFLICT → 抛（pi 转 error tool result 喂回模型自纠）；Provider 401/余额 / 存储不可达 → `terminate: true` + `turnContext.fatal = { code, message }`，Worker 收尾以 fatal 为准。

**fake StreamFn 是确定性支点（§14.1）。** `StreamFn` 是纯函数 `(model, context, options?) => AssistantMessageEventStream`。测试按预设脚本回放工具调用序列，无网络零花费——Worker 编排、自评重生、超限转向、select 终止全部用它测；真实模型只在手动冒烟脚本出现。

## File Structure

```text
src/infrastructure/postgres/agent-turn-queue.mjs
                                           requestTurn / claimNextTurn / renewTurnLease / finishTurn
src/agent/turn-context.mjs                 基准图指针 + fatal 标记 + imageCount（§5.7/§9.2/§9.3）
src/agent/tools/read-photo-state.mjs
src/agent/tools/generate-image.mjs
src/agent/tools/select-candidate.mjs
src/agent/system-prompt.mjs                §5.8 要点表 → 文案（纯文本导出）
src/agent/agent-runner.mjs                 Session 桥 + Agent 组装 + 事件回写（修正 1 的薄编排层）
src/worker/agent-turn-worker.mjs           单轮编排：领取→心跳→run→收尾
src/worker/main.mjs                        并发调度 + 优雅关闭（恢复 start:worker）
src/config.mjs                             loadWorkerConfig 补 5 个变量
test/support/fake-stream-fn.mjs            可编程 StreamFn
test/agent-tools.test.mjs
test/agent-turn-worker.test.mjs
test-integration/agent-turn-queue.test.mjs 真实 PostgreSQL
scripts/probe-chat.mjs                     Task 1 探针（独立于现有 probe-providers.mjs，或并入）
scripts/smoke-agent.mjs                    端到端冒烟（真实 LLM，手动）
docs/superpowers/specs/probe-samples/      探针样本归档（2a 惯例）
```

不修改：`src/domain/**`、`src/api/**`、`src/infrastructure/postgres/session/**`、`migrations/**`、2a 的 `models/storage/telemetry`。

---

### Task 1: 文本侧 function calling 探针（§17 头号 assumption）

**没有 LLM_API_KEY 就停在这里。** 本任务回答三个只能靠实物回答的问题，任何一票否决都要在写任何 Agent 代码之前浮出：

1. DeepSeek 对 `/chat/completions` 的 **tool_calls 是否稳定返回**（含参数 JSON 可解析、多轮 tool roundtrip：第一次 tool_calls → 回传 tool result → 模型继续）
2. **图片输入是否真的被接受**（`llm-provider.mjs` 声明的 `input: ['text','image']` 是声明不是事实；自评循环 §5.4 的命门）
3. 三个工具的 **typebox schema 以 OpenAI tools 格式序列化后**，模型产出的参数是否符合白名单路径（14 条 modify / 12 条 preserve 的枚举约束是否被遵守）

**Files:**
- Create: `scripts/probe-chat.mjs`（或扩展 `probe-providers.mjs` 的 `probeChat()`——它已写了大半，补 roundtrip 与 schema 两问）
- Create: `docs/superpowers/specs/probe-samples/chat-*.json`（响应样本归档）

- [ ] **Step 1: 跑通最小 tool_calls 探针**——单工具（report_color 风格）+ 纯文本，确认返回结构
- [ ] **Step 2: 多轮 roundtrip 探针**——tool_calls → 构造 tool result 回传 → 模型给出最终回答；这正是 Agent 循环的原子形态
- [ ] **Step 3: 图片输入探针**——`image_url`（base64 data URL）+ 文本混合输入，确认 200 且理解图内容（问图的颜色，2a 已有现成小图可复用 `smoke-image.mjs` 的产物）
- [ ] **Step 4: 真实三工具 schema 探针**——探针脚本内**手写一份内联的 schema 草稿**（三个工具的 OpenAI tools 格式，enum 编码白名单路径），让模型执行「读取状态 → 生成海边背景图」的最小链路，观察 patch 路径合法性。Task 3 的生产 schema 照探针样本反推定稿——**不是反过来**（本任务先于 Task 3，此时生产 schema 尚不存在）
- [ ] **Step 5: 样本归档 + 结论写进本计划尾部**（`## 探针结论` 节，实施中回填）。**若图片输入被拒**：降级路径是自评循环改文字描述回传（生成图的 alt 文本由图像侧 metadata 提供），system prompt 相应调整——这是产品级取舍，当场与用户确认，不带猜
- [ ] **Step 6: `npm test` 不回归**（本任务只加脚本与文档）

---

### Task 2: agent-turn-queue（一轮只尝试一次）

**Files:**
- Create: `src/infrastructure/postgres/agent-turn-queue.mjs`
- Create: `test-integration/agent-turn-queue.test.mjs`
- Modify: `src/config.mjs`（`loadWorkerConfig` 补 `turnLeaseMs`：`TURN_LEASE_MS` 默认 30_000——Task 5 补其余四个）

**Interfaces（Produces）:**
- `createAgentTurnQueue({ pool })` 返回：
  - `requestTurn({ projectId, userMessage, idempotencyKey })`——单事务：`INSERT ... ON CONFLICT (project_id, idempotency_key) DO NOTHING`；0 行受影响时 SELECT 既有行，`user_message` 相同 → `{ turnId, replayed: true }`，不同 → 抛 `IdempotencyConflictError`（类在本文件定义，`IDEMPOTENCY_CONFLICT`）。**唯一约束冲突就地处理，不冒泡**（§7.5）；同事务内 `UPDATE projects SET running_turn_id`，已被占用 → `ProjectBusyError`（`PROJECT_BUSY`，语义已是轮次级）
  - `claimNextTurn()`——`FOR UPDATE SKIP LOCKED` 领一条 `queued`（按 `agent_turns_queue_idx` 序），置 `running` + 新 `lease_token`（`crypto.randomUUID`）+ `lease_expires_at = now + TURN_LEASE_MS`，返回 `{ id, projectId, userMessage, leaseToken }`；无可领 → null
  - `failExpiredTurns()`——`running` 且 `lease_expires_at <= now` 的轮：置 `failed`、写 `error_json`（`WORKER_LEASE_EXPIRED`）、释放 `projects.running_turn_id`，**返回处理条数**；由主循环领取前调用。这就是"不重领"的全部实现
  - `renewTurnLease({ turnId, leaseToken })`——token 不匹配或轮非 running → `TurnLeaseLostError`（不写库）
  - `finishTurn({ turnId, leaseToken, status, outcome, error })`——单事务：token 校验 + `UPDATE agent_turns(status ∈ completed|failed|aborted, outcome_json, error_json)` + 释放 `running_turn_id`；幂等（已终态且相同 → 直接返回）

- [ ] **Step 1: 集成测试先行**（沿用 `postgres-repository.test.mjs` 的夹具约定）：
```text
1. requestTurn 新建 → queued，占 running_turn_id
2. requestTurn 同 key 同消息 → replayed: true，不占锁
3. requestTurn 同 key 异消息 → IDEMPOTENCY_CONFLICT（23505 不冒泡为 RESOURCE_CONFLICT）
4. requestTurn 项目已有在跑轮 → PROJECT_BUSY
5. claimNextTurn 领取 → running + lease_token + 过期时间
6. 两个项目各一轮，SKIP LOCKED 下两次 claim 各得其一（并发基础）
7. failExpiredTurns：手工把 lease_expires_at 改过去 → failed + 锁释放 + 不再可领
8. renewTurnLease 续租成功；错误 token → TurnLeaseLostError
9. finishTurn completed → outcome_json 落库 + 锁释放；重复 finish 幂等
10. finishTurn 错误 token → TurnLeaseLostError 且状态未变
```
- [ ] **Step 2: 实现至全绿**。lease 时长由 `loadWorkerConfig` 的 `turnLeaseMs` 注入
- [ ] **Step 3: `npm test` 与全套集成不回归**

---

### Task 3: 轮次上下文与三个工具

**Files:**
- Create: `src/agent/turn-context.mjs`、`src/agent/tools/{read-photo-state,generate-image,select-candidate}.mjs`
- Create: `test/agent-tools.test.mjs`

**Interfaces（Produces）:**
- `createTurnContext({ projectId, initialBaseAssetId })` → `{ currentBaseAssetId, origin, imageCount, fatal, noteImage() , advanceBase(assetId), setFatal(code, message) }`——纯内存对象，Worker 每轮新建
- `createReadPhotoStateTool({ repository, turnContext })` → `AgentTool`（typebox：无参数）→ `{ revisionId, state, baseImage: { assetId, origin } }`。origin ∈ `revision_anchor | turn_candidate`（§5.2：返回指针当前值，不是锚定图）
- `createGenerateImageTool({ repository, imagesModels, assetStorage, turnContext, config })` → `AgentTool`，参数 `{ patch, renderPrompt }`：
  - patch schema 用 **enum 编码两张白名单**（§5.3：让模型在生成阶段就受约束，省一轮自纠往返）
  - 执行序：`imageCount` 护栏（≥ 上限抛 `MAX_IMAGES_REACHED`）→ `getRevision` + `applyPhotoStatePatch` 校验（先于花钱）→ `assetStorage.get(currentBaseAssetId 的 uri)` 取基准图字节 → `imagesModels.generateImages(...)`（`IMAGE_TIMEOUT_MS`）→ 字节 `PUT` S3（扩展名按 content type）→ `repository.recordGeneration({ ..., outcome: completed, candidate })` → `turnContext.advanceBase(candidate.assetId)` → 返回 `{ generationId, candidateId, assetId }` + `ImageContent`（模型看图自评）
  - Provider 401/余额/持续 429、存储不可达 → `terminate: true` + `setFatal(...)`（§9.1 不可纠正类）；其余一律抛
- `createSelectCandidateTool({ repository, turnContext })` → `AgentTool`，参数 `{ generationId, candidateId }` → `selectCandidate` → `{ revisionId }` + **`terminate: true`**

**Consumes:** 2b 的 `recordGeneration` / `selectCandidate` / `getRevision`；2a 的 `createRelayImagesModels` / `AssetStorage`。

- [ ] **Step 1: `test/agent-tools.test.mjs` 先行**（fake repository / fake imagesModels / fake storage，全部内存实现）：
```text
read_photo_state 返回指针当前值与 origin 标记
generate_image：合法 patch → 生图 → 落库 → 指针推进 → 返回 ImageContent
generate_image：非法 patch → 抛（不生图、不落库、不花钱）
generate_image：第三次调用（上限 2 的配置）→ MAX_IMAGES_REACHED 抛错
generate_image：Provider 401 → terminate + fatal 置位
generate_image：基准图取自 turn_candidate（第二次调用的输入图是第一次产出）
select_candidate：成功 → terminate:true；revision 切换
select_candidate：错误 candidateId → 抛（可纠正类）
```
- [ ] **Step 2: 实现至绿**。工具只做薄适配——**`src/domain/` 零改动**是验收线
- [ ] **Step 3: `npm run check` + 全套回归**

---

### Task 4: system prompt 与 Agent 运行桥

**Files:**
- Create: `src/agent/system-prompt.mjs`、`src/agent/agent-runner.mjs`
- Create: `test/support/fake-stream-fn.mjs`（本任务建测试支点，Task 5 复用）
- Modify: `src/config.mjs`（若需）

**Interfaces（Produces）:**
- `SYSTEM_PROMPT` 纯文本导出——逐条覆盖 §5.8 的九行要点表（先读后做 / patch 与 renderPrompt 分工 / 合并意图 / 看图评估 / 缺陷才重生 / 反问不猜 / 满意即选 / 人像默认 preserve identity / preserve 不进 renderPrompt）。**初版只求"覆盖全部要点"，调优是切片 2 结束后的独立工作**（§5.8 明说跑通与调好分开）
- `runAgentTurn({ pool, sessionRepo, config, turn, tools, streamFn })` → `Promise<{ kind: 'completed'|'aborted'|'failed', fatal }>`：
  1. Session 定位（实测 `repo.mjs` 签名：`create({ id })` / `open({ id })`，无 openOrCreate）：session id 固定为 `project:<projectId>`（一 project 一 session，多轮共享轨迹）。

     **先 `open` 后 `create`，不是反过来**：切片 1 的 `open()` 内部调 `requireSession`，会当场抛 `not_found`（`session/repo.mjs`），因此它能可靠区分存在与否。正常路径是多轮对话——session 早已存在，先 `open` 命中率高，只有首轮才走一次异常：

     ```js
     try { return await repo.open({ id }); }
     catch (error) {
       if (error?.code !== 'not_found') throw error;
       return repo.create({ id });
     }
     ```

     反向写法（先 create 捕 `already_exists`）会让每一轮都抛一次异常。这个 dance 封装在 runner 内部私有函数里
  2. `session.appendMessage(userMessage)`
  3. 读分支 entries → `buildSessionContext(entries)` → `{ messages, thinkingLevel, model, activeToolNames }`

     取 entries 用 **`session.findEntriesOnBranch()` 无参调用**即可：`start` 默认取当前 lane 的 leaf（存储契约注释：*"defaulting to a lane's leaf is view sugar"*），不需要自己算起点
  4. `new Agent({ streamFn, initialState })`——`initialState` 的合法字段以 `AgentState`（`dist/types.d.ts` 实测）为准：`{ systemPrompt, model, tools, messages }`（**没有 `activeTools` 字段**，那是 harness 的词汇）
  5. 回写 Session 的事件集**已钉死**（`AgentEvent` 联合实测）：订阅 `agent.subscribe((event, signal) => ...)`，在 **`turn_end { message, toolResults }`** 一个事件里拿全本轮的 assistant 消息与工具结果——`session.appendMessage(message)` + `appendCustomEntry('tool_results', ...)`，不需要逐事件回写；`agent_end { messages }` 兜底全量核对
  6. `agent.prompt(userMessage)`；整轮超时 = `setTimeout(TURN_TIMEOUT_MS) → agent.abort()`（`Agent.abort()` 实测存在；当前运行的 signal 可经 subscribe 第二参数观测）
  7. 归一化返回：异常 / 已 abort / 正常结束 → 三态 + fatal
- stdout telemetry 已由 2a 的 `createStdoutTelemetry` 提供，`Agent` 的 `onPayload`/`onResponse` 钩子接入即可让 `pi.ai.request` span 覆盖生图与文本（§11.4 的验收在冒烟时看 stdout 三类 span）

- [ ] **Step 1: system prompt 初版**（要点表逐条对照自查）
- [ ] **Step 2: agent-runner 桥**——Session 定位 / `initialState` / 事件回写按上文已钉死的实测 API 实现；先建 `test/support/fake-stream-fn.mjs`（`createFakeStreamFn(script)`：按脚本顺序产出 `AssistantMessageEvent` 流），桥的单测直接用它。

**`stopReason` 只能取实测的合法值**（`pi-ai/dist/types.d.ts:277`）：

```ts
type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred"
```

**没有 `'end'`**：本轮有工具调用用 `'toolUse'`，正常收尾用 `'stop'`。fake 写错值不会报错——`Agent` 只会静默走错分支，测试断言莫名其妙地不成立
- [ ] **Step 3: 多轮可见性验证**（内存 repo 即可）：同一 session 第二次 run，`buildSessionContext` 返回的 messages 包含第一轮的用户消息与 assistant 回复（§18 验收：多轮对话可用）

---

### Task 5: Worker 与进程内并发

**Files:**
- Create: `src/worker/agent-turn-worker.mjs`、`src/worker/main.mjs`
- Create: `test/agent-turn-worker.test.mjs`
- Modify: `src/config.mjs`（`TURN_HEARTBEAT_MS` 10_000 / `WORKER_CONCURRENCY` 4 / `SHUTDOWN_GRACE_MS` 600_000 / `WORKER_POLL_INTERVAL_MS` 500）、`package.json`（恢复 `start:worker`）

**Interfaces:**
- `createAgentTurnWorker({ queue, runTurn, config, timers })`——`runOnce()`：`failExpiredTurns()` → `claimNextTurn()` → 心跳启动 → `runAgentTurn`（整轮超时在 runner 内部：`setTimeout(TURN_TIMEOUT_MS) → agent.abort()`）→ `finishTurn`（终态 = runOutcome + fatal 判定：fatal 存在 → `failed`；超时 → `aborted`；否则 `completed`）→ 停心跳。心跳丢失（`TurnLeaseLostError`）→ 跳过 finishTurn（旧实例无权写）
- `src/worker/main.mjs`——校验配置 → 建 pool/models/storage/queue → 主循环维持 ≤ `WORKER_CONCURRENCY` 个在途轮（不是串行 `await`）；SIGTERM → 停止领取、`Promise.race`([全部在途, SHUTDOWN_GRACE_MS]) 后退出

- [ ] **Step 1: 复用 Task 4 建好的 `fake-stream-fn.mjs`，为 Worker 剧本补充编排断言**（三段式：解析参数 → 下一个事件 → EOF）
- [ ] **Step 2: worker 单测**（fake queue + fake streamFn，心跳用注入 timer）：
```text
完整一轮：claim → run(脚本: read→generate→select) → finishTurn completed
自评重生脚本（generate×2 → select）→ 两次 recordGeneration、指针两次推进
超限脚本（generate×3 上限 2）→ 第三次工具抛错 → 模型转向 select（脚本编排）→ completed
fatal 剧本（generate 401）→ finishTurn failed + error_json 含 fatal code
整轮超时 → aborted（abortController 触发）
心跳 token 失效 → 不再 finishTurn
优雅关闭：SIGTERM 后不 claim 新轮、在途轮跑完退出
```
- [ ] **Step 3: main.mjs 并发调度**——两个 fake 轮并行推进互不阻塞（单测用 fake queue 验证并发上限）
- [ ] **Step 4: 恢复 `start:worker`，全套回归绿**

---

### Task 6: 端到端冒烟与收尾

**Files:**
- Create: `scripts/smoke-agent.mjs`
- Modify: `README.md`

- [ ] **Step 1: 冒烟脚本**（手动，真实 `LLM_API_KEY` + 真实图像供应商）：建 project（带基准图）→ `requestTurn("把背景换成海边")` → 起 Worker 跑完 → 断言：turn `completed`、`generations` 有记录、新 Revision 生效、`agent_sessions` 里能查到本轮全部 entries（用户消息、tool_call、tool_result）、MinIO 里有产物、stdout 有 `pi.ai.request`（operation 含 generateImages）与工具事件
- [ ] **Step 2: 对照 §18 逐条自查本切片 accountable 项**：轨迹可回放 / 多轮可见 / 基准图推进 / 同轮重 roll / select 终止 / 成本护栏 / fatal 中止 / 看图自评（依赖 Task 1 结论）
- [ ] **Step 3: README 更新**（运行手册：环境变量表、冒烟步骤、2d 展望）+ 全套回归最终绿

---

## 切片 2c 完成标准

- `npm test` / `npm run test:integration` 全绿；新增 fake-StreamFn 单测覆盖编排全部分支
- **Task 1 探针结论已归档**：function calling 稳定性与图片输入是事实而非假设（或降级决策已记录并与用户确认）
- 冒烟脚本跑通真实链路：消息 → 工具调用 → 真实出图落 MinIO → 新 Revision → `select_candidate` 终止
- Agent 轨迹在 PostgreSQL 可回放；第二轮消息能看到第一轮历史
- 同轮两次 `generate_image`（同 patch）产生两条 generation（2b 验收的延续，真链路复验）
- 超 `MAX_IMAGES_PER_TURN` 后模型转向选图；fatal 错误中止整轮不空转
- 两个项目并行推进互不阻塞（`WORKER_CONCURRENCY` 生效）
- `src/domain/**`、`src/api/**`、`session/**`、`migrations/**` 零改动（git diff 为证）
- Worker stdout 可 `| jq` 逐行解析，无自由文本混入

## 探针结论

（Task 1 Step 5 回填：tool_calls 稳定性 / 图片输入 / schema 遵守度 / 降级决策）

## 下一步

切片 2d：API 路由重写（`POST /projects/:id/messages` → `requestTurn`、`GET .../turns/:turnId`、selections、mapError 补 `TURN_NOT_FOUND`/`PROJECT_BUSY`/`IDEMPOTENCY_CONFLICT` 的轮次级语义）、S3 签名 URL、端到端冒烟、README 定稿。
