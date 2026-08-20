# PhotoAgent 迁移到 Pi Agent Harness 设计

**日期：** 2026-08-20
**状态：** 已确认
**范围：** 用 Pi Agent Harness 替换手写编辑工作流；改造 HTTP API、数据库 schema、Worker、依赖与运行配置
**取代：** `2026-08-19-edit-interpreter-design.md`、`2026-08-19-model-capability-separation-design.md`（两份文档保留，记录当初的边界推理）

## 1. Context

当前 PhotoAgent 已完成三条纵切：Domain + PostgreSQL 生成闭环、LanguageModel 与 ImageGenerationProvider 能力边界分离、内部 EditInterpreter。

编排逻辑是**固定工作流**：

```text
message → LanguageModel.planPatch() → Patch → requestGeneration() → Worker 生图 → Candidate → 用户选 → Revision
```

这条链路每一步都写死在 `EditInterpreter.interpretAndRequestGeneration()` 里。以下能力无法在该结构上生长：

1. 多轮对话式编辑（"再亮一点"依赖上一轮上下文）；
2. 编辑能力持续增加（每加一种就要动 Patch schema 和分支代码）；
3. 换模型 / 换供应商；
4. Agent 自主多步（分析 → 生成 → 自评 → 重试）；
5. Skills 与 Plugins。

本设计用 [Pi Agent Harness](https://pi.dev) 替换该工作流，并把 Domain 能力降级为 Agent 工具。

## 2. Linus 三问

### 2.1 这是真问题还是想象的？

是真问题。上述五类拓展没有一条能在固定工作流上实现，全部需要"模型决定下一步做什么"的循环结构。继续修补 `EditInterpreter` 只会长出 `if (intent === 'xxx')` 分支树。

### 2.2 有没有更简单的方法？

有，且已采纳：**不自研 agent 循环，直接用 pi**。

pi 提供的三样东西恰好覆盖需求，且都是公开扩展点，无需 fork：

- `AgentHarness`：工具调用循环、session 注入、lane 并发控制、skills/prompt-templates 挂载
- `createProvider` / `createImagesProvider`：文本与图像供应商适配
- `SessionStorage` 接口 + 官方 conformance 套件：自定义持久化后端

不采用的更复杂方案：
- 自研 agent 循环；
- fork pi 源码（见 §3.2）；
- 把 Agent 塞进 HTTP 请求进程（见 §3.1）。

### 2.3 会破坏什么？

**会破坏且已接受：**

- `src/application/edit-interpreter.mjs` 与 `mock-language-model.mjs` 删除
- HTTP API：`POST /projects/:id/generations`、`GET /generations/:id` 删除
- `generation_jobs` 表改名并瘦身，`provider_jobs` 表删除
- `src/worker/generation-worker.mjs` 重写

**不破坏：**

- `src/domain/**` 全部保留，17 个 domain 单测一行不改（`photo-state` 6 + `project-workflow` 11）
- `photo_revisions`、`assets`、`projects` 的核心语义
- Lease + heartbeat + `FOR UPDATE SKIP LOCKED` 队列机制（换 payload，不换机制）
- Revision 冲突检测、项目锁、幂等语义

## 3. Decision

### 3.1 进程边界：Agent 跑在 Worker，不跑在 API

```text
┌─ API 进程（无状态，不加载 pi Agent）─────────────────┐
│  POST /projects/:id/messages                       │
│    → 事务：写 agent_turns + 幂等记录 + 锁 project    │
│    → 202 { turnId }                                 │
│  GET  /turns/:turnId                                │
│  GET  /projects/:id                                 │
└────────────────────────────────────────────────────┘
                     │ PostgreSQL（唯一事实来源）
┌─ Worker 进程（加载 pi）─────────────────────────────┐
│  FOR UPDATE SKIP LOCKED 领取 agent_turn             │
│  lease_token + heartbeat（覆盖整轮，含多次生图）      │
│  new AgentHarness({ session, models, tools })       │
│  harness.run(userMessage)                           │
│  RunOutcome → 落库 → 释放 lease 与 project 锁        │
└────────────────────────────────────────────────────┘
```

**否决「Agent 跑在 API 进程」**：单次生图 30–90 秒，一轮可能多次。Web 场景下用户会刷新页面、切标签、断网、锁屏；Agent 与 HTTP 连接绑定意味着断连即产生孤儿轮次——没人接管，也没人能重连。

**否决「Agent 在 API 流式跑、生图入队给 Worker」**：其唯一卖点是流式体验，而流式在本方案中可由 `SessionStorage.getLog({ afterSeq })` 的增量游标实现（Worker 写 session，API 开只读 SSE 端点 tail）。该方案付出跨进程等待与双向生命周期管理的复杂度，却买不到本方案没有的东西，且 HTTP 请求仍需挂满整轮。

**核心原则：Web 系统里「谁在跑 agent」必须和「谁在看 agent」解耦。**

### 3.2 用 npm 依赖，不 copy 源码

pi 三个包合计约 37,000 行 TypeScript（`pi-ai` 23,555 / `pi-agent-core` 12,635 / `pi-telemetry` 935），外部依赖包含 `@anthropic-ai/sdk`、`@aws-sdk/client-bedrock-runtime`、`@google/genai`、`openai`、`typebox`、`yaml` 等。

copy 进来会引入 TypeScript 构建链并与上游断开，而本项目需要的两处定制——自定义图像供应商、自定义 session 后端——**pi 均提供公开扩展点**。证据：sqlite session 后端本身就是独立 npm 包 `@earendil-works/pi-session-backend-sqlite-node`，不在 core 内，说明"第三方在包外实现后端"是 pi 的设计意图。

npm 上 `@earendil-works/pi-agent-core@0.84.2` 与本地 checkout 同版本。pi 发布 ESM `dist` + `.d.ts`，本项目的 `.mjs` 直接 import，**不引入构建步骤**。

`/Users/zzsy/PycharmProjects/pi` 保留作为源码阅读参考。

### 3.3 用 AgentHarness，不用底层 Agent

```ts
interface AgentHarnessOptions {
  session: Session;                 // 外部注入 → 挂 Postgres 后端
  models: Models;
  model: Model<Api>;
  tools?: HarnessTool[];            // Domain 能力挂载点
  resources?: Resources;            // = AgentHarnessResources<Skill, PromptTemplate>
  systemPrompt?: string | (() => string | Promise<string>);
  ...
}
```

底层 `Agent` 没有 `session` 注入、没有 `resources`（skills）、没有 lane 并发控制。三条需求都指向 `AgentHarness`。

`RunOutcome` 的四种取值 `completed | aborted | failed | suspended` 直接映射轮次终态，不自研状态机。

## 4. 模型接线

两条独立管道，均指向同一个 OpenAI 兼容中转站。

### 4.1 文本（Agent 的大脑）

模板照搬 pi 内置的 OpenAI 兼容供应商（`src/providers/deepseek.ts`，14 行）：

```js
import { createProvider, createModels, envApiKeyAuth } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

const models = createModels();
models.setProvider(createProvider({
  id: 'relay',
  name: 'Relay',
  baseUrl: process.env.RELAY_BASE_URL,
  auth: { apiKey: envApiKeyAuth('Relay API key', ['RELAY_API_KEY']) },
  models: [ /* Model：api:'openai-completions', baseUrl, input:['text','image'], cost, ... */ ],
  api: openAICompletionsApi(),
}));
```

模型必须 `input` 含 `'image'`——Agent 需要看见生成的图做自评（§5.3）。

### 4.2 图像

中转站走 OpenAI 官方 Images API（`/v1/images/generations`、`/v1/images/edits`），pi 内置的 `openrouter-images` 走的是 `chat.completions` + `modalities`，格式不匹配，因此**必须写自定义 provider**。

`ImagesApi` 的类型是 `KnownImagesApi | (string & {})`——开放字符串，允许自定义 api id：

```js
import { createImagesModels, createImagesProvider } from '@earendil-works/pi-ai';

const imagesModels = createImagesModels();
imagesModels.setProvider(createImagesProvider({
  id: 'relay',
  auth: { apiKey: envApiKeyAuth('Relay API key', ['RELAY_API_KEY']) },
  models: [{
    id: 'gpt-image-2',
    name: 'GPT Image 2',
    api: 'relay-openai-images',
    provider: 'relay',
    baseUrl: process.env.RELAY_BASE_URL,
    input: ['text', 'image'],
    output: ['image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }],
  api: { generateImages: relayGenerateImages },   // 本项目实现，约 100 行
}));
```

**不使用 `registerImagesApiProvider`**：`createImagesProvider` 直接携带 `generateImages`，`ImagesModels` 调度时直接派发到 provider，无需全局注册表，也避免引入内置 provider 的副作用导入。

`relayGenerateImages` 的契约是 pi 的 `ImagesFunction`：

```ts
(model: ImagesModel, context: ImagesContext, options?: ImagesOptions) => Promise<AssistantImages>
```

其中 `ImagesContext.input: (TextContent | ImageContent)[]`——原图 + 文本指令，正是换背景/换衣/保身份所需的 img2img 能力。

以后接即梦、通义万相或自建服务 = 再写一个 `ImagesFunction`，Agent 侧与 Tools 侧零改动。

**同步语义的后果：** pi 的 `generateImages` 返回 `Promise<AssistantImages>`，没有 provider job id、没有轮询、没有供应商级幂等键。这使得现有的 `provider_jobs` 异步恢复机制失去目标（§7.3）。

## 5. Tools 契约

### 5.1 反面设计

```js
// ❌ 把整条流水线包进一个工具 = 旧工作流套 LLM 皮，拓展性零收益
edit_photo({ message })
```

### 5.2 实际契约

```js
read_photo_state()
  → { revisionId, state, anchorAssetUri }

generate_image({ patch, renderPrompt })
  → { generationId, candidates: [{ candidateId, assetId }] }
  → content 附带生成图本体（ImageContent）

select_candidate({ generationId, candidateId })
  → { revisionId }
```

两个参数分工不同，不可合并：

- **`patch`** 是结构化 Photo State Patch，**持久化**，经 Domain 校验，决定新 Revision 的状态。它是系统的事实记录。
- **`renderPrompt`** 是发给图像模型的自然语言指令，**不持久化到 Photo State**，仅记入 `generations.metadata_json` 供审计。它承载 patch 表达不了的渲染细节（"柔和黄昏侧光""保持人物面部特征不变"）。

若只留 `patch`，渲染细节无处安放；若只留 `renderPrompt`，Photo State 失去结构化事实来源，Revision 无法比较和回溯。

三者正交：`read` 让 Agent 知道现状，`generate` 是唯一花钱的动作，`select` 是唯一改变项目状态的动作。参数 schema 用 typebox（pi 的 `AgentTool<TParameters extends TSchema>`）。

对照旧工作流新增的能力：

| 场景 | 旧工作流 | 新契约 |
|---|---|---|
| 一次改背景 + 改衣服 | 两次请求 | 一个 patch 多字段，一次生图 |
| 同条件重 roll | 做不到（幂等键绑死 patch） | 再调一次 `generate_image` |
| 先看现状再决定 | 做不到 | `read_photo_state` |

### 5.3 Agent 看得见自己生成的图

`AgentToolResult.content` 的类型是 `(TextContent | ImageContent)[]`。`generate_image` 把候选图作为 `ImageContent` 返回，模型下一轮直接看到图：

```text
用户："把背景换成海边"
  → read_photo_state
  → generate_image({ background: '海边沙滩，黄昏' })
  → [模型看图] "人物边缘有光晕，背景过曝"
  → generate_image({ background: '海边沙滩，柔和黄昏侧光' })
  → [模型看图] "这版好"
  → select_candidate
```

「自主多步：生成 → 自评 → 重试」**不需要任何额外机制**。

### 5.4 Tool 与 Domain 的边界

Tool 是薄适配层，只做三件事：typebox schema 声明、调用 Domain 方法、把结果转成 `AgentToolResult`。

**所有业务规则留在 `src/domain/`**：patch 校验、Revision 冲突检测、状态机合法性。理由有二：模型会传出任意参数，校验必须在模型够不着的地方；这些规则已有 17 个单测覆盖，不应搬家。

### 5.5 拓展路径

- **加编辑维度**（发型、姿势、光线）→ 扩 Photo State patch schema，**零新工具**
- **加新动作**（放大、去水印、扩图）→ 加一个 tool，复用同一套 revision/candidate 机制
- **加领域知识**（证件照规范、电商主图规范）→ 走 `AgentHarnessOptions.resources` 挂 skill，**零代码**

## 6. 对象存储

### 6.1 决策

图片字节存 S3 兼容对象存储，不存 PostgreSQL、不写本地文件系统。

阿里云 OSS、腾讯 COS、MinIO **均提供 S3 兼容 API**，因此**一个适配器覆盖三种部署**：开发环境跑 MinIO 容器，生产切换 endpoint + bucket + 凭证。

```text
src/infrastructure/storage/
  asset-storage.mjs        Port：put(key, bytes, contentType) / getSignedUrl(key) / delete(key)
  s3-asset-storage.mjs     S3 兼容实现（MinIO / OSS / COS 通吃）
```

**否决 PostgreSQL bytea**：图片进数据库是会后悔的决定，仅为 MVP 省事不成立。
**否决本地文件系统**：多 Worker / 多 API 实例部署下失效，需要共享文件系统。

### 6.2 路径结构

```text
users/{ownerId}/projects/{projectId}/{assetId}.png
```

`projects` 表新增 `owner_id text NOT NULL DEFAULT 'dev'`。MVP 阶段 `ownerId` 从请求头取、缺省 `dev`；接入鉴权后换成真实用户 ID，**路径结构不变、已存对象不搬迁**。

现在不加 `owner_id` 的话，接鉴权时需要做一次对象迁移。

### 6.3 assets 表

不变。`uri` 字段存对象键。

`compose.yaml` 新增 MinIO 服务，与 postgres 并列；`npm run db:up` 改名 `npm run dev:up`。

## 7. 数据模型变更

### 7.1 新增 agent_turns

队列项。`generation_jobs` 的 lease 机制原样迁移。

```sql
CREATE TABLE agent_turns (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  user_message text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','completed','failed','aborted')),
  attempt_count int NOT NULL DEFAULT 0,
  lease_token text,
  lease_expires_at timestamptz,
  outcome_json jsonb,
  error_json jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (project_id, idempotency_key)
);
```

**队列的作业单位从 Generation 升级为 Agent Turn。** 一轮内 Agent 可调用 N 次工具、生 M 次图。`FOR UPDATE SKIP LOCKED`、lease token、heartbeat、幂等逻辑全部复用，仅 payload 改变。

### 7.2 generation_jobs → generations

改名理由：它不再是队列项，**名字骗人的代价高于写迁移的代价**。

状态机从 9 态砍到 2 态：

```text
旧：queued|preparing|submitted|provider_processing|verifying|completed|partial_failed|failed|cancelled
新：completed | failed
```

理由：供应商变同步。Worker 内 `await generateImages()` 要么拿到图要么抛错，**中间态在新架构下不可达**。保留无法到达的状态只会误导后续维护者。

同时：删除 lease 相关列（迁至 `agent_turns`），新增 `turn_id` 外键。

### 7.3 provider_jobs：删除

该表存在的唯一理由是异步供应商任务的崩溃恢复。供应商同步化后该理由消失，留下一张无人读写的表是负债。审计信息记入 `generations.metadata_json`。

### 7.4 projects

- `running_generation_id` → `running_turn_id`
- 新增 `owner_id text NOT NULL DEFAULT 'dev'`

### 7.5 photo_revisions / assets

不变。

## 8. 幂等与重试

### 8.1 新问题

旧架构一个 job = 一次生图，幂等键直接护住扣费。新架构**一轮 Agent 可能调 N 次 `generate_image`，每次都花钱**。轮次跑到一半崩溃后重领重跑，已生成的图白花钱。

Tool 级幂等在此**不成立**：重跑时模型重新推理，`toolCallId` 会变，调用序列也可能变，不存在稳定的键。

### 8.2 决定

**`agent_turns.attempt_count` 上限设为 1。一轮失败即失败，不自动重试。**

- 不重跑 → 不存在重复扣费
- 让用户重发消息本就是更合理的产品行为（用户往往想换说法）
- Lease 机制仍然必要：它防的是 Worker 假死后旧实例继续写库，该威胁未变

### 8.3 升级路径

将来需要自动重试时，采用语义指纹幂等键：

```text
hash(turnId, baseRevisionId, patch, 本轮内相同 patch 的第几次调用)
```

调用序号是必要成分：没有它，模型主动重 roll（用户说"再来一版"）会错误命中缓存。

## 9. 错误处理

### 9.1 两类错误，处理方式相反

**可纠正错误** —— 模型改参数即可通过。**抛异常**，pi 自动转成 error tool result 喂回模型自纠：

```text
patch 校验失败 → "INVALID_PATCH: background 必须是字符串" → 模型改参数重试
candidateId 不存在 → 模型重新读候选
REVISION_CONFLICT → 模型重新 read_photo_state
```

这是 agent 架构的真实红利：**不写纠错分支**。

**不可纠正错误** —— 模型重试无用，必须中止整轮：

```text
中转站 401 / 余额不足 / 持续 429
对象存储不可达
PostgreSQL 断连
```

这类**不抛异常**，返回带 `terminate: true` 的结果：

```js
return {
  content: [{ type: 'text', text: '图像服务不可用：余额不足' }],
  details: { fatal: true, code: 'PROVIDER_UNAVAILABLE' },
  terminate: true,
};
```

### 9.2 terminate 不可单独依赖

pi 的契约明确：

> Early termination only happens when **every** finalized tool result in the batch sets this to true.

模型一批调两个工具、仅其一致命时循环会继续。因此 tool 同时把 fatal 标记写入**轮次上下文对象**（经 `toolContext` 注入），Worker 在 `harness.run()` 返回后**以轮次上下文为准**判定终态。`terminate` 仅作"尽早停止省钱"的优化。

注：`AgentToolResult` 没有 `isError` 字段，工具标记错误的唯一途径是抛异常；这正是不可纠正错误需要走 `terminate` + 上下文标记的原因。

### 9.3 成本护栏

**每轮 `generate_image` 调用次数硬上限，默认 3 次**，由轮次上下文计数，通过 `MAX_IMAGES_PER_TURN` 配置（§12.1）。超限后 tool 抛错："本轮生图次数已用尽，请从已有候选中选择"。模型收到后转向选图而非继续生成。

没有这条护栏，模型的自评循环会持续烧钱。

### 9.4 模型层错误

pi 的 `StreamFn` 契约规定不抛异常，错误编码进 stream，最终 `AssistantMessage.stopReason` 为 `error` / `aborted`。中转站 chat 接口故障时 `RunOutcome.kind = 'failed'`，Worker 写 `error_json`，异常不穿透。

## 10. 并发与超时

### 10.1 三层保护

| 层 | 机制 | 防什么 |
|---|---|---|
| 跨进程 | `projects.running_turn_id` + `FOR UPDATE SKIP LOCKED` | 同一项目两个 Worker 同时跑 |
| 进程内 | pi 的 lane 控制（`RunRejected` 含 `LaneBusy`） | 同进程内重入 |
| 写保护 | lease token | Worker 假死后旧实例继续写库 |

pi 的 lane 控制只在进程内有效，**PostgreSQL 的锁是权威**。两层并存，pi 那层是免费的二次保险。

### 10.2 超时

- **单次生图**：`ImagesOptions.timeoutMs`，默认 180 秒（`IMAGE_TIMEOUT_MS`）
- **整轮**：Worker 持 `AbortController`，默认上限 10 分钟（`TURN_TIMEOUT_MS`），超时 `harness.abort()` → `RunOutcome.kind = 'aborted'`
- **lease**：30 秒租约（`TURN_LEASE_MS`）+ 10 秒心跳（`TURN_HEARTBEAT_MS`），覆盖整轮（含多次生图）

变量清单见 §12.1。

## 11. Session 存储与可观测性

### 11.1 目标状态：PostgreSQL 后端

Web 系统下 jsonl 文件后端要求共享文件系统，不可接受。目标是自实现 `SessionStorage`。

成本已核实：

- 契约为 `SessionStorage`，**20 个方法**，本质是 append-only entries + records + lane 指针 + 少量 kv fact
- pi 提供**官方一致性测试套件** `@earendil-works/pi-agent-core/session/testing` 的 `createSessionBackendConformance`（1016 行），可直接用于验收
- pi 提供**可逐文件对照的 SQL 参考实现** `packages/session-backends/sqlite-node`，storage 层约 800 行（`entries.ts` 78 / `records.ts` 95 / `lanes.ts` 124 / `sessions.ts` 131 / `branch-entries.ts` 174 / `facts.ts` 64 / `session-stats.ts` 54 / `session-sequences.ts` 29 / `branch-tips.ts` 35 / `writer-leases.ts` 58）
- `memory.ts` 仅 192 行即实现完整契约，证明契约是薄的

估算：800–1000 行 SQL storage 层，有现成验收套件与对照实现。

### 11.2 MVP 阶段：MemorySessionStorage

切片 1 使用 pi 自带的 `MemorySessionStorage`。

**后果：session 不跨轮持久化，多轮对话在切片 1 中不工作。** 发第二条消息时 Agent 看不到第一轮历史。

这不影响 MVP 验收线（一轮，一次真实生图）。切片 2 换成 PostgreSQL 后端后多轮自动生效，**Tools 与 Worker 代码零改动**——这是 `SessionStorage` 作为注入契约的直接收益。

### 11.3 三层可观测性

pi 提供三种互不重叠的观测手段，不可混为一谈。

| 层 | 内容 | pi 是否自带 | 持久化 |
|---|---|---|---|
| **Session（轨迹）** | entries：message / model_change / compaction / branch_summary / custom；records：operation 生命周期 | 自带 | 是，落 `SessionStorage` |
| **Telemetry（span）** | 12 个 span 的 schema 与埋点 | **契约自带，exporter 不带** | 取决于 adapter |
| **Agent events（实时）** | `agent_start` / `turn_start` / `message_update` / `tool_execution_start` / `tool_execution_end` / `agent_end` | 自带 | 否，仅供 UI 订阅 |

**Session 是"发生了什么"的可回放记录**，也是切片 3 的 SSE 数据源（§15）。`CustomEntry { type: 'custom', customType, data }` 允许把业务自定义日志条目并入同一条时间线，无需另开表。

**Telemetry 的边界必须写清楚。** `@earendil-works/pi-telemetry` 的定位是：

> no exporter, global current-span state, or dependency on a telemetry backend

pi 声明的 span（见 `packages/agent/docs/telemetry-schema.md`，该文档由脚本生成）：

```text
pi.ai.request        operation ∈ {stream, fetch_deferred, cancel_deferred, generate_images}
pi.harness.run / .turn / .step / .tool / .hook
pi.harness.compaction / .navigation / .checkpoint / .sleep / .event_handler
pi.session.write
```

`pi.harness.tool` 携带 `pi.tool.name`、`pi.tool.call_id`、`pi.tool.is_error`、`pi.tool.recovery`。
`pi.ai.request` 的 operation 枚举含 `generate_images`，**生图调用在 span 覆盖范围内**。

注入点：`AgentHarnessOptions.context?: TelemetryContext`。pi 现成实现只有 `InMemoryTelemetryContext`（参考）与 `NOOP_TELEMETRY_CONTEXT`（默认）。落到任何后端都需自实现 adapter，pi 提供 conformance 套件验收。

### 11.4 切片 1 必须接 stdout telemetry adapter

**这是一条硬要求，不是可选优化。**

切片 1 同时使用 `MemorySessionStorage`（轨迹不落库）与默认的 `NOOP_TELEMETRY_CONTEXT`（无 span 输出）。两者叠加的后果是：**切片 1 出问题时没有任何可查的日志**——而切片 1 恰恰是风险最高的一刀（首次接真实中转站，function calling 稳定性仍是 assumption，见 §17）。

因此切片 1 实现一个最简 `TelemetryContext` adapter，按结构化 JSON 行输出到 stdout：

```text
src/infrastructure/telemetry/stdout-telemetry.mjs
```

`TelemetryContext` 是 callback 契约，实现成本低，但可直接观测到：

- 每次 `pi.ai.request` 的耗时与 operation（含 `generate_images`）
- 每个 `pi.harness.tool` 调用了什么、是否出错
- 整轮 `pi.harness.run` 的边界与终态

通过 `TELEMETRY=stdout|noop` 切换（§12.1），默认 `stdout`。

将来做成本统计与配额（§16 Non-goals）时，基础就是这些 span 加 `AgentHarness.recordUsage()`，无需另起炉灶。

## 12. File Layout 与运行配置

新增：

```text
src/agent/harness-factory.mjs           构造 AgentHarness（models、tools、systemPrompt、session）
src/agent/tools/read-photo-state.mjs
src/agent/tools/generate-image.mjs
src/agent/tools/select-candidate.mjs
src/agent/turn-context.mjs              轮次上下文：fatal 标记、生图计数
src/infrastructure/models/relay-text-provider.mjs
src/infrastructure/models/relay-images-provider.mjs   relayGenerateImages 实现
src/infrastructure/storage/asset-storage.mjs
src/infrastructure/storage/s3-asset-storage.mjs
src/infrastructure/telemetry/stdout-telemetry.mjs   TelemetryContext adapter（§11.4）
src/infrastructure/postgres/agent-turn-queue.mjs
migrations/005_agent_turns.sql          创建 agent_turns
migrations/006_generations_slim.sql     generation_jobs → generations；状态机砍到 2 态；删 lease 列；加 turn_id
migrations/007_projects_owner.sql       running_generation_id → running_turn_id；新增 owner_id
migrations/008_drop_provider_jobs.sql   删除 provider_jobs
test/agent-tools.test.mjs
test/agent-turn-worker.test.mjs
test/relay-images-provider.test.mjs
test/support/fake-stream-fn.mjs         可编程 StreamFn
scripts/smoke-e2e.mjs
.env.example                            运行配置模板（见 §12.1）
```

修改：

```text
src/api/server.mjs
src/worker/generation-worker.mjs        → src/worker/agent-turn-worker.mjs
src/infrastructure/postgres/photo-project-repository.mjs
compose.yaml                            新增 MinIO
package.json                            新增依赖与脚本
README.md
test-integration/postgres-repository.test.mjs
```

删除：

```text
src/application/edit-interpreter.mjs
src/application/mock-language-model.mjs
src/worker/mock-image-provider.mjs
src/infrastructure/postgres/generation-queue.mjs
test/edit-interpreter.test.mjs          （12 个用例，能力移入 agent-tools.test.mjs）
test/generation-worker.test.mjs         （5 个用例，被 agent-turn-worker.test.mjs 取代）
```

不修改：

```text
src/domain/**
test/photo-state.test.mjs               （6 个用例）
test/project-workflow.test.mjs          （11 个用例）
```

新增依赖：

```text
@earendil-works/pi-agent-core@0.84.2
@earendil-works/pi-ai@0.84.2
@aws-sdk/client-s3
typebox
```

### 12.1 运行配置

现有变量，不变：

| 变量 | 默认值 | 用途 |
|---|---|---|
| `DATABASE_URL` | `postgres://photo_agent:photo_agent@127.0.0.1:54329/photo_agent` | PostgreSQL 连接 |
| `PORT` | `3000` | API 监听端口 |
| `WORKER_POLL_INTERVAL_MS` | `1000` | Worker 轮询间隔 |

本次新增：

| 变量 | 默认值 | 用途 | 缺失时行为 |
|---|---|---|---|
| `RELAY_BASE_URL` | 无 | 中转站 base URL，文本与图像共用 | Worker 启动失败 |
| `RELAY_API_KEY` | 无 | 中转站 API key | Worker 启动失败 |
| `RELAY_TEXT_MODEL` | `gpt-5.4` | Agent 大脑模型 id | 用默认值 |
| `RELAY_IMAGE_MODEL` | `gpt-image-2` | 图像模型 id | 用默认值 |
| `S3_ENDPOINT` | `http://127.0.0.1:9000` | 对象存储 endpoint（MinIO / OSS / COS） | 用默认值 |
| `S3_BUCKET` | `photo-agent` | bucket 名 | 用默认值 |
| `S3_ACCESS_KEY` | 无 | 对象存储 access key | Worker 启动失败 |
| `S3_SECRET_KEY` | 无 | 对象存储 secret key | Worker 启动失败 |
| `S3_REGION` | `us-east-1` | S3 兼容 API 要求非空，MinIO 忽略该值 | 用默认值 |
| `MAX_IMAGES_PER_TURN` | `3` | 每轮 `generate_image` 硬上限（§9.3 成本护栏） | 用默认值 |
| `IMAGE_TIMEOUT_MS` | `180000` | 单次生图超时（§10.2） | 用默认值 |
| `TURN_TIMEOUT_MS` | `600000` | 整轮超时，超时触发 `harness.abort()`（§10.2） | 用默认值 |
| `TURN_LEASE_MS` | `30000` | 轮次租约时长 | 用默认值 |
| `TURN_HEARTBEAT_MS` | `10000` | 心跳续租间隔 | 用默认值 |
| `TELEMETRY` | `stdout` | span 输出方式，`stdout` \| `noop`（§11.4） | 用默认值 |

规则：

- **凭证类变量（`RELAY_API_KEY`、`S3_ACCESS_KEY`、`S3_SECRET_KEY`、`RELAY_BASE_URL`）缺失时 Worker 启动即失败**，不允许延迟到第一次生图才报错——那会让一轮白白进入 running 状态再失败。
- 其余变量有默认值，本地开箱可跑。
- API 进程只需 `DATABASE_URL`、`PORT`、`S3_*`（生成候选图的签名 URL 用），**不需要中转站凭证**——API 不加载 pi Agent（§3.1）。

`.env.example` 随实现一并提供。

## 13. API 变更

```text
POST /projects                                    保留
GET  /projects/:id                                保留
POST /projects/:id/messages                       新增（替代 generations）
GET  /turns/:turnId                               新增
POST /projects/:id/turns/:turnId/selections       改造（用户手动选，与 select_candidate 走同一 Domain 方法）
GET  /health                                      保留

POST /projects/:id/generations                    删除
GET  /generations/:id                             删除
```

幂等键继续通过 `Idempotency-Key` 请求头传递，作用域变为 agent turn。

## 14. Test Strategy

### 14.1 测试支点：可编程 fake StreamFn

`StreamFn` 是纯函数类型：

```ts
(model, context, options?) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>
```

假实现按预设脚本返回工具调用序列，即可**完全确定性地**编排"模型调了哪些工具、什么顺序、拿到结果后如何反应"——无需 mock 整个 LLM，无网络，不花钱。

这接续 commit `b20f3d0` 的 programmable language model adapter 思路，契约换成 pi 的 `StreamFn`。

### 14.2 分层

| 层 | 内容 | 依赖 |
|---|---|---|
| Domain 单测（保留现有 17 个） | photo-state、状态机、patch 校验 | 无，一行不改 |
| Tools 单测 | 参数校验、错误分类、成本护栏计数 | fake repository + fake images provider |
| ImagesProvider 单测 | multipart 组装、b64/URL 响应解析、401/429 归类为 fatal | fake fetch |
| Worker 轮次单测 | 编排正确性：自评重生、超限后停、fatal 中止 | fake StreamFn + fake provider |
| 集成测试 | 全链路 | 真实 PostgreSQL + 真实 MinIO + fake StreamFn + fake provider |
| 端到端冒烟 | 真实中转站真出图 | `npm run smoke:e2e`，手动执行，**不进 CI** |
| 切片 2 | PostgreSQL SessionStorage | pi 官方 `createSessionBackendConformance` |

**集成测试用真基础设施 + 假模型**：基础设施是 bug 藏身处，模型是花钱的地方。

测试框架不变，继续用 `node:test`，不引入 vitest。pi 发布 ESM dist，`.mjs` 直接 import。

## 15. 实施切片

### 切片 1（MVP 验收线）

自定义 ImagesProvider → Tools → AgentHarness（MemorySessionStorage）→ Worker → 真实出图 → 新 Revision。

### 切片 2

`SessionStorage` 换 PostgreSQL 实现，跑 pi conformance 套件。多轮对话生效。**接口不变，纯替换，零返工。**

### 切片 3

SSE 端点，基于 `getLog({ afterSeq })` 增量推送 Agent 进展。

## 16. Non-goals

本设计不实现：

- 鉴权与用户体系（仅预埋 `owner_id`）
- 前端
- SSE / 流式（切片 3）
- PostgreSQL SessionStorage（切片 2）
- 轮次自动重试与语义指纹幂等（§8.3）
- 对象存储垃圾回收
- 多模型路由与 fallback
- 成本统计与配额
- Skills / Plugins 的具体内容（仅确保挂载点可用）
- 即梦 / 通义万相等其他图像供应商适配

## 17. Risks And Assumptions

- **assumption：中转站的 `/v1/chat/completions` 支持稳定的 function calling。** 若工具调用不稳定，整个 agent 循环不成立。这是切片 1 必须最先验证的一点。
- **assumption：中转站的 `/v1/images/edits` 接受原图 + prompt 并返回可解析的 b64 或 URL。** 实际响应格式在实现 `relayGenerateImages` 时以真实响应为准。
- **assumption：中转站返回的图片 URL 若有时效，必须在轮次内立即下载并转存对象存储。** 不直接把中转站 URL 存入 `assets.uri`。
- 模型输出只能当作不可信输入，必须经过 Domain 校验；结构化输出不等于合法业务操作。
- MemorySessionStorage 阶段 Worker 崩溃即丢失该轮；`attempt_count = 1` 使其不可恢复。这是明确的阶段性限制。
- pi 版本 0.84.2 处于 0.x，API 可能变化。锁定精确版本，升级作为独立任务处理。
- 生图耗时受中转站影响，10 分钟整轮上限可能需要按实测调整。

## 18. Acceptance Criteria

- `npm test` 全绿：Domain 17 个（不变）+ Tools + Worker 轮次 + ImagesProvider
- `npm run test:integration` 全绿：真实 PostgreSQL + 真实 MinIO 全链路
- `npm run smoke:e2e` 跑通：用户消息 → Agent 调工具 → 中转站真实出图 → MinIO 中可见图片对象 → 新 Revision 创建且 `active_revision_id` 切换
- Agent 能看到自己生成的图（`generate_image` 返回 `ImageContent`）
- 成本护栏生效：超过每轮生图上限后 Agent 转向选图
- 不可纠正错误中止整轮，不让模型空转
- `npm run smoke:e2e` 的 stdout 中可见 `pi.harness.run`、`pi.harness.tool`、`pi.ai.request`（`operation=generate_images`）三类 span，且带耗时（§11.4）
- `src/domain/**` 未修改
- README 与设计文档使用同一套术语：Agent Turn / Tool / ImagesProvider / SessionStorage
