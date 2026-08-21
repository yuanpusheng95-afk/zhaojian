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
- `generation_jobs` 表改名并瘦身，`provider_jobs` 与 `idempotency_requests` 表删除
- `src/worker/generation-worker.mjs` 重写
- **`src/domain/photo-project-service.mjs` 的项目锁逻辑必须改**（§10.3）。锁从「一次生图」上移到「一轮」，`project-workflow.test.mjs` 11 个用例中 2 个随之调整

**不破坏：**

- `src/domain/photo-state.mjs` 与全部 patch 校验规则，**6 个单测一行不改**
- `project-workflow.test.mjs` 11 个中的 9 个（Revision 冲突、幂等、候选选择、状态机迁移）
- `photo_revisions`、`assets`、`projects` 的核心语义
- Lease + heartbeat + `FOR UPDATE SKIP LOCKED` 的**思路**沿用（默认值也不变：30s 租约 / 10s 心跳）
- Revision 冲突检测、幂等语义

**注意：队列是重写，不是改 payload。** `generation-queue.mjs` 现有的 `claimNext()` 会重领过期租约（`status = ANY(ACTIVE_STATUSES) AND lease_expires_at <= now`）、递增 `attempt_count`、`maxAttempts=3` 耗尽后 `#failExhausted()`。新设计不重领、无计数（§8.2），且 `ACTIVE_STATUSES` 依赖的四个中间态在新状态机下已不存在（§7.2）。**照抄旧队列会引入一套没有依据的重试逻辑。**

## 3. Decision

### 3.1 进程边界：Agent 跑在 Worker，不跑在 API

```text
┌─ API 进程（无状态，不加载 pi Agent）─────────────────┐
│  POST /projects/:id/messages                       │
│    → 事务：写 agent_turns（含幂等唯一约束）+ 锁 project│
│    → 202 { turnId }                                 │
│  GET  /projects/:id/turns/:turnId                   │
│  POST /projects/:id/turns/:turnId/selections        │
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

### 3.4 一轮的完整时序

分散在 §5、§7、§13 的细节在此串成一条线，作为实施时的对照基准。

```text
POST /projects/p1/messages { message: "把背景换成海边" }   Idempotency-Key: m-1
 │
 ├─ 单事务：INSERT agent_turns(queued)         ← UNIQUE 冲突则查既有行返回其 turnId
 │          UPDATE projects.running_turn_id    ← 已被占用则 409 PROJECT_BUSY
 └─ 202 { turnId }

Worker
 ├─ FOR UPDATE SKIP LOCKED 领 queued 轮次 → status=running + lease_token
 ├─ 启动心跳（10s 续租），覆盖整轮
 ├─ 打开该 project 的 Session（PostgreSQL backend）
 ├─ 初始化轮次上下文：currentBaseAssetId = Revision.anchorAssetId, imageCount = 0
 ├─ new AgentHarness({ session, models, model, tools, systemPrompt, context: telemetry })
 └─ harness.run(userMessage)
      │
      ├─ read_photo_state
      │    └─ SELECT revision → { revisionId, state, baseImage:{assetId, origin} }
      │
      ├─ generate_image({ patch, renderPrompt })
      │    ├─ imageCount >= MAX_IMAGES_PER_TURN ? 抛错并返回
      │    ├─ Domain 校验 patch（非法 → 抛错，pi 转 error result 让模型自纠）
      │    ├─ 对象存储 get(currentBaseAssetId 对应的 uri) → 基准图字节
      │    ├─ ImagesContext.input = [ImageContent(基准图), TextContent(renderPrompt)]
      │    ├─ imagesModels.generateImages(...)      ← 唯一花钱的调用，30–90s
      │    ├─ 产出字节 PUT 对象存储（扩展名按 content type）
      │    ├─ 单事务：INSERT assets + generations + generation_outputs
      │    ├─ currentBaseAssetId = 首张候选; imageCount++
      │    └─ 返回 { generationId, candidates } + ImageContent(候选图) 给模型
      │
      ├─ [模型看图自评 → 可能再次 generate_image，回到上一步]
      │
      └─ select_candidate({ generationId, candidateId })
           ├─ 单事务：INSERT photo_revisions + UPDATE projects.active_revision_id
           │           + UPDATE generations.selected_candidate_id/selected_revision_id
           └─ 返回 { revisionId } + terminate:true → 本轮结束

Worker 收尾
 ├─ RunOutcome(completed|aborted|failed) + 轮次上下文的 fatal 标记 → 判定终态
 ├─ 单事务：UPDATE agent_turns(status, outcome_json, error_json)
 │           + UPDATE projects.running_turn_id = NULL
 └─ 停止心跳，释放 lease

GET /projects/p1/turns/{turnId} → §13 的返回体（候选图带签名 URL）
```

**所有写库动作都标了事务边界。** 三处单事务是不变量的守护点：入队与占锁必须原子（否则轮次入队后没锁住项目），产出落库必须原子（否则出现有 asset 无 generation 的孤儿），收尾必须原子（否则轮次结束了但项目锁没释放）。

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
  → { revisionId, state, baseImage: { assetId, origin } }
      origin ∈ { 'revision_anchor', 'turn_candidate' }

generate_image({ patch, renderPrompt })
  → { generationId, candidates: [{ candidateId, assetId }] }
  → content 附带生成图本体（ImageContent）

select_candidate({ generationId, candidateId })
  → { revisionId }
  → terminate: true —— 本轮到此结束
```

**`read_photo_state` 返回的是当前基准图，不是 Revision 的锚定图。** 两者在一轮内会分叉：调过一次 `generate_image` 后基准图指针已推进到候选（§5.6）。若这里仍返回 Revision 锚定图，模型读到的"当前的图"与它下一次实际编辑的图不是同一张，自评和后续 patch 都会建立在错误认知上。`origin` 字段显式告诉模型这是原始锚定图还是本轮的中间产物。

不返回 URI：Agent 没有取图工具，图由 `generate_image` 内部按 `assetId` 取。给模型一个它用不了的 URI 只是在烧 token。

**`select_candidate` 一轮只能调一次，且调用即结束本轮。** 返回结果带 `terminate: true`。理由：选中意味着用户意图已达成，继续留在同一轮里编辑会让「一轮 = 一次用户意图」的语义失效，也让项目锁的释放时机变得含糊。用户想接着改，发下一条消息即可——那本来就是新一轮。

**`generate_image` 的两个参数分工不同，不可合并：**

- **`patch`** 是结构化 Photo State Patch，**持久化**，经 Domain 校验，决定新 Revision 的状态。它是系统的事实记录。
- **`renderPrompt`** 是发给图像模型的自然语言指令，**不持久化到 Photo State**，仅记入 `generations.metadata_json` 供审计。它承载 patch 表达不了的渲染细节（"柔和黄昏侧光""保持人物面部特征不变"）。

若只留 `patch`，渲染细节无处安放；若只留 `renderPrompt`，Photo State 失去结构化事实来源，Revision 无法比较和回溯。

三者正交：`read` 让 Agent 知道现状，`generate` 是唯一花钱的动作，`select` 是唯一改变项目状态的动作。参数 schema 用 typebox（pi 的 `AgentTool<TParameters extends TSchema>`）。

对照旧工作流新增的能力：

| 场景 | 旧工作流 | 新契约 |
|---|---|---|
| 一次改背景 + 改衣服 | 两次请求 | 一个 patch 多字段，一次生图 |
| 同条件重 roll | 做不到（幂等键绑死 patch） | 再调一次 `generate_image`（前提：§7.2 必须删掉旧唯一约束） |
| 先看现状再决定 | 做不到 | `read_photo_state` |
| 在上一版结果上继续微调 | 做不到 | 基准图指针自动推进（§5.6） |

### 5.3 Agent 看得见自己生成的图

`AgentToolResult.content` 的类型是 `(TextContent | ImageContent)[]`。`generate_image` 把候选图作为 `ImageContent` 返回，模型下一轮直接看到图：

```text
用户："把背景换成海边"
  → read_photo_state
  → generate_image({
      patch: { background: '海边沙滩' },
      renderPrompt: '黄昏光线，保持人物面部特征不变',
    })
  → [模型看图] "人物边缘有光晕，背景过曝"
  → generate_image({
      patch: { background: '海边沙滩' },
      renderPrompt: '柔和黄昏侧光，避免边缘光晕与过曝，保持人物面部特征不变',
    })
  → [模型看图] "这版好"
  → select_candidate
```

注意第二次调用的 `patch` 与第一次**完全相同**——目标状态没变，变的只是渲染指令。这正是 §5.2 里两个参数不可合并的实证。

「自主多步：生成 → 自评 → 重试」**不需要任何额外机制**。

### 5.4 Tool 与 Domain 的边界

Tool 是薄适配层，只做三件事：typebox schema 声明、调用 Domain 方法、把结果转成 `AgentToolResult`。

**所有业务规则留在 `src/domain/`**：patch 校验、Revision 冲突检测、状态机合法性。理由有二：模型会传出任意参数，校验必须在模型够不着的地方；这些规则已有 17 个单测覆盖，不应搬家。

### 5.5 拓展路径

- **加编辑维度**（发型、姿势、光线）→ 扩 Photo State patch schema，**零新工具**
- **加新动作**（放大、去水印、扩图）→ 加一个 tool，复用同一套 revision/candidate 机制
- **加领域知识**（证件照规范、电商主图规范）→ 走 `AgentHarnessOptions.resources` 挂 skill，**零代码**

### 5.6 基准图与输入图

`generate_image` 的参数里没有图。输入图由**轮次上下文维护的基准图指针** `currentBaseAssetId` 决定，Agent 不能直接指定——否则模型可以任意挑图，产生无法解释的编辑链。

规则：

```text
轮次开始           currentBaseAssetId = 当前 Revision 的 anchorAssetId    origin = revision_anchor
generate_image 后  currentBaseAssetId = 本次产出的候选（多张时取第一张）    origin = turn_candidate
select_candidate 后 固化为新 Revision 的 anchor，本轮结束（§5.2）
```

一句话：**选中优先，否则用上一次候选图。** `read_photo_state` 始终返回这个指针的当前值，不是 Revision 的锚定图。

数据流：

```text
generate_image({ patch, renderPrompt })
  → 从 currentBaseAssetId 查 assets.uri
  → 对象存储取字节
  → ImageContent + TextContent(renderPrompt) 组成 ImagesContext.input
  → imagesModels.generateImages(...)
  → 产出字节 PUT 对象存储 → INSERT assets + generations + generation_outputs
  → 更新 currentBaseAssetId
  → 返回 { generationId, candidates } + ImageContent 给模型
```

`candidateId` 即 `generation_outputs.id`。

**已知代价（用户已确认接受）：** 在生成物上反复编辑会逐代劣化——人脸漂移、画质衰减，三四轮后明显。缓解手段不进 MVP，但路径是现成的：`patch` 是持久化的累积事实，随时可以从原始锚定图带全量 patch 重生一次。将来可作为「重置画质」动作暴露。

### 5.7 System Prompt

Agent 的行为不是架构的自然结果，而是 system prompt 的产物。§5.3 那条「生成 → 自评 → 重试」链路，没有明确引导不会发生。

MVP 的 system prompt 必须覆盖以下几条，逐条对应一个已知失败模式：

| 指令要点 | 不写会怎样 |
|---|---|
| 先 `read_photo_state` 再动手 | 模型凭空猜当前状态，patch 与事实不符 |
| `patch` 写目标状态，`renderPrompt` 写渲染细节 | 两者混用，Photo State 被塞进自然语言 |
| 一次意图尽量合并进一个 patch | 拆成多次生图，成本翻倍 |
| 生成后必须看图评估 | 拿到图就 `select_candidate`，自评能力形同虚设 |
| 明显缺陷才重生，最多 `MAX_IMAGES_PER_TURN` 次 | 无限追求完美，烧到护栏才停 |
| 用户意图不明确时**反问而非猜测** | 猜错方向，白花一次生图 |
| 满意后调 `select_candidate` 结束 | 轮次跑到超时才结束 |
| 人像编辑默认保持人物身份特征 | 换背景顺手把脸也换了 |

存放位置 `src/agent/system-prompt.mjs`，纯文本导出，不做模板引擎。

**它是需要迭代调优的产物，不是一次写对的代码。** 因此实施计划中应把「跑通」与「调好」分开：切片 2 的验收只要求链路走通，prompt 的效果调优是随后的独立工作。将来沉淀出的领域规范（证件照、电商主图）走 `resources` 挂 skill（§5.5），不往 system prompt 里堆。

## 6. 对象存储

### 6.1 决策

图片字节存 S3 兼容对象存储，不存 PostgreSQL、不写本地文件系统。

阿里云 OSS、腾讯 COS、MinIO **均提供 S3 兼容 API**，因此**一个适配器覆盖三种部署**：开发环境跑 MinIO 容器，生产切换 endpoint + bucket + 凭证。

```text
src/infrastructure/storage/
  asset-storage.mjs        Port：put(key, bytes, contentType) / get(key) / getSignedUrl(key)
  s3-asset-storage.mjs     S3 兼容实现（MinIO / OSS / COS 通吃）
```

`get(key)` 是必需的——`generate_image` 要把基准图字节喂给图像模型（§5.6）。**不提供 `delete()`**：垃圾回收是 non-goal（§16），MVP 无人调用，加一个死方法只会让人以为清理逻辑已经存在。

**否决 PostgreSQL bytea**：图片进数据库是会后悔的决定，仅为 MVP 省事不成立。
**否决本地文件系统**：多 Worker / 多 API 实例部署下失效，需要共享文件系统。

### 6.2 路径结构

```text
users/{ownerId}/projects/{projectId}/{assetId}.{ext}
```

`ext` 由图像模型响应的 content type 推导（`image/png` → `png`、`image/webp` → `webp`、`image/jpeg` → `jpg`），**不写死 `.png`**——gpt-image-2 及后续供应商可能返回 webp 或 jpeg，写死会让文件名骗人。content type 同时存入 `assets.metadata_json`，签名 URL 据此设 `Content-Type`。

`projects` 表新增 `owner_id text NOT NULL DEFAULT 'dev'`。MVP 阶段 `ownerId` 从请求头取、缺省 `dev`；接入鉴权后换成真实用户 ID，**路径结构不变、已存对象不搬迁**。

现在不加 `owner_id` 的话，接鉴权时需要做一次对象迁移。

### 6.3 assets 表

**表结构不变，但写入代码必须改。**

现有两处插入（`photo-project-repository.mjs` 第 63、310 行）都是：

```sql
INSERT INTO assets (id, kind, created_at)
```

**`uri` 与 `metadata_json` 从来没被写过。** 不改的话 `uri` 恒为 NULL，§5.6 数据流里「按 `assetId` 查 `assets.uri` 取基准图字节」会取空——这是整条 img2img 链路上的断点。

两处都要补写 `uri`（对象键）与 `metadata_json`（至少含 content type，供签名 URL 设头与扩展名推导）。

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
  lease_token text,
  lease_expires_at timestamptz,
  outcome_json jsonb,
  error_json jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (project_id, idempotency_key)
);
```

**没有 `attempt_count` 列。** 上限既然是 1（§8.2），计数器就是多余的状态：`status='queued'` 表示从未被领取，`status='running'` 且 lease 过期表示已尝试过一次——直接判 `failed`。用一个计数器表达一个布尔事实，是在给未来的读者制造"这里可以重试多次"的错觉。

**队列的作业单位从 Generation 升级为 Agent Turn。** 一轮内 Agent 可调用 N 次工具、生 M 次图。`FOR UPDATE SKIP LOCKED` 的领取思路与 lease/heartbeat 的默认值沿用，但**重领与重试逻辑不沿用**（§2.3、§8.2）。

### 7.2 generation_jobs → generations

改名理由：它不再是队列项，**名字骗人的代价高于写迁移的代价**。

状态机从 9 态砍到 2 态：

```text
旧：queued|preparing|submitted|provider_processing|verifying|completed|partial_failed|failed|cancelled
新：completed | failed
```

理由：供应商变同步。Worker 内 `await generateImages()` 要么拿到图要么抛错，**中间态在新架构下不可达**。保留无法到达的状态只会误导后续维护者。

同时逐列清算——旧表每一列都要有明确去留，不能只改状态机就算完：

| 列 | 处置 | 理由 |
|---|---|---|
| `id` / `project_id` | 保留 | |
| `input_revision_id` | 保留，语义收窄 | 只表示「patch 基于哪个 Revision 的状态计算」，**不再表示输入图** |
| **`input_asset_id`（新增）** | `NOT NULL REFERENCES assets(id)` | 实际喂给图像模型的基准图。可能是 Revision 锚定图，也可能是本轮的候选图（§5.6）——后者不属于任何 Revision，`input_revision_id` 表达不了 |
| `patch_json` / `proposed_state_json` | 保留 | |
| `status` | 9 态 → 2 态 | 见上 |
| **`idempotency_key`** | **删除** | 幂等作用域已移至 `agent_turns`（§7.5） |
| **`UNIQUE (project_id, idempotency_key)`** | **删除** | 留着会直接打死「同条件重 roll」（§5.2）：同一轮内两次相同条件的生图必然撞约束 |
| `selected_candidate_id` / `selected_revision_id` | 保留 | 语义不变，记录哪个候选被选中、产生了哪个 Revision |
| `operation` | 删除 | 旧值恒为 `'edit'`，是 EditInterpreter 时代的遗留。新架构下「做什么」由 tool 名和 patch 表达 |
| `last_error_json` | 保留 | |
| lease 相关列 | 删除 | 迁至 `agent_turns` |
| **`turn_id`（新增）** | `NOT NULL REFERENCES agent_turns(id)` | |
| `generation_jobs_queue_idx` | 删除 | 按 `status, created_at` 的队列索引——它不再是队列 |

**`UNIQUE (project_id, idempotency_key)` 这条最危险**：它不会报错，只会让重 roll 静默失败，而重 roll 恰是本次架构宣称的新能力。

**改名的连带影响（迁移里必须处理）：** 三个外键约束指向旧表名，重命名后需一并重建——

```text
photo_revisions.source_generation_id  → REFERENCES generations(id)
generation_outputs.generation_id      → REFERENCES generations(id)
projects.running_generation_id        → 该列本身被替换，见 §7.4
```

PostgreSQL 的 `ALTER TABLE ... RENAME TO` 会自动携带约束，但约束**名字**仍带旧表名，需显式改名，否则后续维护者读 `\d` 时会看到指向不存在概念的约束名。

### 7.3 provider_jobs：删除

该表存在的唯一理由是异步供应商任务的崩溃恢复。供应商同步化后该理由消失，留下一张无人读写的表是负债。审计信息记入 `generations.metadata_json`。

### 7.4 projects

- `running_generation_id`（FK → `generation_jobs`）→ **替换为** `running_turn_id text REFERENCES agent_turns(id)`。这不是列改名，是换了引用目标：项目锁的持有者从「一次生图」变成「一轮 Agent」（§7.1）。旧列与旧 FK 一并删除。
- 新增 `owner_id text NOT NULL DEFAULT 'dev'`

### 7.5 idempotency_requests：删除

旧表结构是 `(project_id, idempotency_key) → generation_id`，即幂等键指向一次生图。新架构下幂等作用域是 agent turn，而 `agent_turns` 已带 `UNIQUE (project_id, idempotency_key)`（§7.1），**约束本身就是幂等记录**，单独一张映射表是冗余的。

重复提交同一 `Idempotency-Key` 时，插入 `agent_turns` 触发唯一约束冲突，转为查询既有行并返回其 `turnId`，语义与旧实现一致。

### 7.6 photo_revisions / assets / generation_outputs

列定义不变。`photo_revisions.source_generation_id` 与 `generation_outputs.generation_id` 的外键目标随表改名重建（§7.2）。`assets.uri` 语义从"未使用"变为"对象存储键"（§6.3）。

## 8. 幂等与重试

### 8.1 新问题

旧架构一个 job = 一次生图，幂等键直接护住扣费。新架构**一轮 Agent 可能调 N 次 `generate_image`，每次都花钱**。轮次跑到一半崩溃后重领重跑，已生成的图白花钱。

Tool 级幂等在此**不成立**：重跑时模型重新推理，`toolCallId` 会变，调用序列也可能变，不存在稳定的键。

### 8.2 决定

**一轮只尝试一次。失败即失败，不自动重试。**

具体规则：Worker 领取时把 `queued` 置为 `running` 并写 lease；若发现某轮 `status='running'` 而 lease 已过期（原 Worker 崩溃或假死），**不重新领取，直接置 `failed` 并释放项目锁**。

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

**每轮 `generate_image` 调用次数硬上限，默认 3 次**，由轮次上下文计数，通过 `MAX_IMAGES_PER_TURN` 配置（§12.2）。超限后 tool 抛错："本轮生图次数已用尽，请从已有候选中选择"。模型收到后转向选图而非继续生成。

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

变量清单见 §12.2。

### 10.3 项目锁从 Generation 上移到 Turn（domain 必须改）

**现状：锁绑在一次生图上，在 domain 里。**

```js
// src/domain/photo-project-service.mjs
168:    if (project.runningGenerationId) {
169:      throw new ProjectBusyError(projectId, project.runningGenerationId);
202:    project.runningGenerationId = generation.id;
273:      project.runningGenerationId && project.runningGenerationId !== generation.id
276:      throw new ProjectBusyError(...)
367:    if (project.runningGenerationId === generation.id) { ... = null }
```

**这挡死了本设计的中心前提。** 一轮 Agent 第一次调 `generate_image` 会设上 `runningGenerationId`，第二次调用直接撞 168 行抛 `ProjectBusyError`。「一轮内多次生图」不成立，则 §5.2 的重 roll、§5.3 的自评重试、§5.6 的基准图推进、§9.3 的三次上限全部作废。

**变更：**

| 位置 | 改法 |
|---|---|
| `requestGeneration()` | 移除 `runningGenerationId` 的检查（168–169）与设置（202）。一轮内可自由多次创建 generation |
| `selectCandidate()` | 移除 `runningGenerationId !== generation.id` 检查（273–276） |
| 清锁逻辑（367–368） | 移除 |
| 互斥的新归属 | `projects.running_turn_id` + `FOR UPDATE SKIP LOCKED`（§7.4、§10.1），由 Worker 领取/释放轮次时维护 |

**语义没有变弱，只是粒度变对了。** 旧规则「同一项目同时只能跑一次生图」在新架构下的正确表述是「同一项目同时只能跑一轮」——而一轮本来就串行执行其内部的生图。互斥强度不变，但允许一轮内多次生图。

**测试影响：** `test/project-workflow.test.mjs` 的 11 个用例中 2 个断言 `ProjectBusyError`（157 行的 `requestGeneration`、326 行的 `selectCandidate`），需改为断言新的轮次级互斥。其余 9 个与 `photo-state.test.mjs` 的 6 个不受影响。

## 11. Session 存储与可观测性


### 11.1 决定：PostgreSQL SessionStorage，切片 1 内完成

**Agent 轨迹必须入 PostgreSQL，不使用 `MemorySessionStorage`，不使用 jsonl 文件后端。**

理由：

- Session 就是轨迹日志（§11.3）。Web 系统里轨迹是产品资产——回溯用户改了什么、复现问题、将来做审计与成本归因，全依赖它。
- 内存后端在进程重启即丢失；jsonl 文件后端要求多 Worker 共享文件系统。两者都不能进生产。
- PostgreSQL 已是本系统唯一事实来源（§3.1）。轨迹落在别处会造成事实分裂。
- 中间态没有价值：先上 Memory 或 jsonl 再换 Postgres，等于为一个必然被替换的实现付出集成与调试成本。

**否决"把 session 后端推到 Agent 接线之后"：** 该方案的唯一收益是早几天摸到真实生图，代价是 MVP 期间没有可回溯轨迹——而首次接真实中转站恰恰是最需要翻现场的时候（见 §17）。

### 11.2 实现成本与路径

契约为 `SessionStorage`，**17 个方法**，本质是 append-only entries + records + lane 指针 + 少量 kv fact。

pi 提供两样东西使这项工作可控：

- **官方一致性测试套件** `@earendil-works/pi-agent-core/session/testing` 的 `createSessionBackendConformance`（1016 行），直接用作验收标准
- **可逐文件对照的 SQL 参考实现** `packages/session-backends/sqlite-node`，storage 层约 800 行：`entries.ts` 78 / `records.ts` 95 / `lanes.ts` 124 / `sessions.ts` 131 / `branch-entries.ts` 174 / `facts.ts` 64 / `session-stats.ts` 54 / `session-sequences.ts` 29 / `branch-tips.ts` 35 / `writer-leases.ts` 58

`memory.ts` 仅 192 行即实现完整契约，证明契约是薄的。

**估算：800–1000 行 SQL storage 层。** 这是本次 MVP 中最大的单块工作量，实施计划中应作为独立可验收单元，先于 Agent 接线完成——因为它有确定性的验收标准（conformance 套件全绿），不依赖真实模型。

表结构对应 sqlite 参考实现的分解：

```text
session_sessions   会话元数据
session_entries    entries（append-only，seq 单调）
session_records    records（operation 生命周期）
session_lanes      lane → leafId 指针
session_facts      name / label 等 kv
```

`seq` 的单调分配在事务内完成，对应参考实现的 `session-sequences.ts`。

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

### 11.4 切片 2 必须接 stdout telemetry adapter

**这是一条硬要求，不是可选优化。**

Session 与 telemetry 记录的是**不重叠的两类事实**：

- Session 记「Agent 做了什么」——消息、工具调用、参数、结果，入 PostgreSQL（§11.1）
- Telemetry span 记「花了多久、在哪一层失败」——生图耗时、中转站错误、重试

生图延迟与供应商级失败**只在 span 里有**，session 不记录这些。切片 2 首次接真实中转站，function calling 稳定性与响应格式均为 assumption（§17），缺少这层数据会让排障退化成猜测。

因此切片 2 实现一个最简 `TelemetryContext` adapter，按结构化 JSON 行输出到 stdout：

```text
src/infrastructure/telemetry/stdout-telemetry.mjs
```

`TelemetryContext` 是 callback 契约，实现成本低，但可直接观测到：

- 每次 `pi.ai.request` 的耗时与 operation（含 `generate_images`）
- 每个 `pi.harness.tool` 调用了什么、是否出错
- 整轮 `pi.harness.run` 的边界与终态

通过 `TELEMETRY=stdout|noop` 切换（§12.2），**默认 `stdout`**。`NOOP_TELEMETRY_CONTEXT` 是 pi 的默认值，本项目显式覆盖它；`noop` 仅供测试中静音使用。

将来做成本统计与配额（§16 Non-goals）时，基础就是这些 span 加 `AgentHarness.recordUsage()`，无需另起炉灶。

## 12. File Layout 与运行配置

新增：

```text
src/agent/harness-factory.mjs           构造 AgentHarness（models、tools、systemPrompt、session）
src/agent/system-prompt.mjs             Agent 行为引导（§5.7）
src/agent/tools/read-photo-state.mjs
src/agent/tools/generate-image.mjs
src/agent/tools/select-candidate.mjs
src/agent/turn-context.mjs              轮次上下文：基准图指针、fatal 标记、生图计数（§5.6、§9.2、§9.3）
src/infrastructure/models/relay-text-provider.mjs
src/infrastructure/models/relay-images-provider.mjs   relayGenerateImages 实现
src/infrastructure/storage/asset-storage.mjs
src/infrastructure/storage/s3-asset-storage.mjs
src/infrastructure/telemetry/stdout-telemetry.mjs   TelemetryContext adapter（§11.4）
src/infrastructure/postgres/agent-turn-queue.mjs
src/infrastructure/postgres/session/storage.mjs      SessionStorage 20 方法（§11.2）
src/infrastructure/postgres/session/entries.mjs
src/infrastructure/postgres/session/records.mjs
src/infrastructure/postgres/session/lanes.mjs
src/infrastructure/postgres/session/facts.mjs
src/infrastructure/postgres/session/sequences.mjs
migrations/005_agent_turns.sql          创建 agent_turns
migrations/006_generations_slim.sql     generation_jobs → generations；逐列清算（§7.2 表）：删 idempotency_key 及其唯一约束、删 operation 与 lease 列、删队列索引、加 input_asset_id 与 turn_id、状态机砍到 2 态、重建并改名外键约束
migrations/007_projects_owner.sql       删 running_generation_id 及其 FK，新增 running_turn_id → agent_turns；新增 owner_id
migrations/008_drop_legacy.sql          删除 provider_jobs 与 idempotency_requests（§7.3、§7.5）
migrations/009_agent_sessions.sql       session_sessions / _entries / _records / _lanes / _facts
test/agent-tools.test.mjs
test/agent-turn-worker.test.mjs
test/relay-images-provider.test.mjs
test/support/fake-stream-fn.mjs         可编程 StreamFn
test-integration/session-storage-conformance.test.mjs   跑 pi 官方套件（需真实 PostgreSQL）
scripts/smoke-e2e.mjs
.env.example                            运行配置模板（见 §12.2）
```

修改：

```text
src/api/server.mjs
src/worker/generation-worker.mjs        → src/worker/agent-turn-worker.mjs
src/domain/photo-project-service.mjs    项目锁从 generation 上移到 turn（§10.3）
src/infrastructure/postgres/photo-project-repository.mjs
test/project-workflow.test.mjs          11 个中的 2 个改断言（§10.3）
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
src/domain/photo-state.mjs              及全部 patch 校验规则
test/photo-state.test.mjs               （6 个用例）
```

新增依赖：

```text
@earendil-works/pi-agent-core@0.84.2
@earendil-works/pi-ai@0.84.2
@aws-sdk/client-s3
typebox
```

### 12.1 photo-project-repository.mjs 方法级改动

该文件 635 行、11 个公开方法。「修改」两个字给不出指引，逐个标明——与 §7.2 的逐列清算同理，避免实施时漏改。

| 方法 | 处置 | 理由 |
|---|---|---|
| `createProject` | **改** | `INSERT INTO assets` 补 `uri` + `metadata_json`（§6.3）；新增 `owner_id` |
| `requestGeneration` | **改** | 移除项目锁检查与设置（§10.3）；删 `idempotency_key` 与 `operation`（§7.2）；新增 `input_asset_id` 与 `turn_id` |
| `transitionGeneration` | **大改** | 九态 `GENERATION_TRANSITIONS` 图砍到 `completed \| failed`；移除 `claimToken`（lease 已迁至 turn） |
| `recordProviderJob` | **删除** | 唯一作用是写 `provider_jobs`，该表删除（§7.3） |
| `addCandidate` | **改** | 移除 `status === 'verifying'` 前置检查（该状态已不存在）与 `claimToken`；`INSERT INTO assets` 补 `uri` + `metadata_json` |
| `selectCandidate` | **小改** | 移除 `runningGenerationId` 相关检查（§10.3）。`selectedCandidateId` 非空则拒绝的逻辑**保留**，与「一轮只选一次」天然兼容 |
| `getProject` / `getGeneration` / `getRevision` | 基本不变 | 随列变更调整投影 |
| `listRevisions` / `listGenerations` | 基本不变 | |

**`addCandidate` 是最容易被漏掉的一个。** 它的两个前置条件在新架构下都塌了：`verifying` 状态不存在，generation 也不再持有 lease。而它正是 `generate_image` 落候选的必经之路——不改则每次生图都抛 `GenerationTransitionError`。

新增（不在现有文件内）：

| 方法 | 归属 | 说明 |
|---|---|---|
| `claimNextTurn` / `renewTurnLease` / `finishTurn` | `agent-turn-queue.mjs` | 见 §2.3：重写，不照抄旧队列 |

### 12.2 运行配置

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
| `RELAY_TEXT_MODEL` | **无** | Agent 大脑模型 id | 启动失败 |
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

- **`RELAY_TEXT_MODEL` 无默认值，必须显式配置。** 本设计不假定中转站提供哪些文本模型——猜一个默认值等于把未经验证的假设伪装成决策。启动时校验存在性；模型 id 由使用者按中转站实际清单填写。
- **凭证与端点类变量缺失时进程启动即失败**，不允许延迟到第一次调用才报错——那会让一轮白白进入 running 状态再失败。Worker 需要 `RELAY_BASE_URL`、`RELAY_API_KEY`、`RELAY_TEXT_MODEL`、`S3_ACCESS_KEY`、`S3_SECRET_KEY`；**API 需要 `S3_ACCESS_KEY`、`S3_SECRET_KEY`**（生成候选图签名 URL 用），缺失时 API 同样启动失败。
- 其余变量有默认值，本地开箱可跑。
- API 进程**不需要中转站凭证**（`RELAY_*`）——API 不加载 pi Agent（§3.1）。

`.env.example` 随实现一并提供。

## 13. API 变更

```text
POST /projects                                    保留
GET  /projects/:id                                保留
POST /projects/:id/messages                       新增（替代 generations）
GET  /projects/:id/turns/:turnId                  新增
POST /projects/:id/turns/:turnId/selections       改造（用户手动选，与 select_candidate 走同一 Domain 方法）
GET  /health                                      保留

POST /projects/:id/generations                    删除
GET  /generations/:id                             删除
```

**路径一律嵌在 `/projects/:id` 下。** turn 属于 project，且接入鉴权后（§6.2 的 `owner_id`）授权检查以 project 为单位；嵌套路径让「先验证 project 归属、再取 turn」成为路径的自然读法，不需要额外反查 turn → project。

`GET /projects/:id/turns/:turnId` 返回体：

```jsonc
{
  "turnId": "t_...",
  "status": "queued | running | completed | failed | aborted",
  "generations": [
    {
      "generationId": "g_...",
      "patch": { },
      "renderPrompt": "...",
      "candidates": [{ "candidateId": "c_...", "assetId": "a_...", "url": "<签名 URL>" }]
    }
  ],
  "selectedCandidateId": "c_... | null",
  "newRevisionId": "r_... | null",
  "error": { "code": "...", "message": "..." }   // 仅 failed 时出现
}
```

`url` 是对象存储签名 URL，由 API 进程按 `assets.uri` 现签（这也是 §12.2 里 API 需要 `S3_*` 凭证的原因）。**不返回图片字节。**

一轮可能有多次 `generate_image`，因此 `generations` 是数组；`selectedCandidateId` 与 `newRevisionId` 最多一个（§5.2：一轮只能选一次）。

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
| Domain 单测 | photo-state（6 个不变）、状态机、patch 校验、**轮次级互斥（2 个改断言，§10.3）** | 无外部依赖 |
| Tools 单测 | 参数校验、错误分类、成本护栏计数、**基准图指针推进规则（§5.6）** | fake repository + fake images provider + fake storage |
| ImagesProvider 单测 | multipart 组装、b64/URL 响应解析、401/429 归类为 fatal | fake fetch |
| Worker 轮次单测 | 编排正确性：自评重生、同条件重 roll、超限后停、`select_candidate` 终止轮次、fatal 中止 | fake StreamFn + fake provider |
| 集成测试 | 全链路 | 真实 PostgreSQL + 真实 MinIO + fake StreamFn + fake provider |
| 端到端冒烟 | 真实中转站真出图 | `npm run smoke:e2e`，手动执行，**不进 CI** |
| PostgreSQL SessionStorage | 17 个方法的契约一致性 | pi 官方 `createSessionBackendConformance` + 真实 PostgreSQL |

**集成测试用真基础设施 + 假模型**：基础设施是 bug 藏身处，模型是花钱的地方。

测试框架不变，继续用 `node:test`，不引入 vitest。pi 发布 ESM dist，`.mjs` 直接 import。

## 15. 实施切片

### 切片 1：PostgreSQL SessionStorage

实现 `SessionStorage` 的 17 个方法，对照 sqlite 参考实现移植（§11.2）。

**独立可验收：pi 的 `createSessionBackendConformance` 套件全绿。** 不依赖真实模型、不依赖中转站、不依赖对象存储，因此可以先于所有 Agent 接线完成，风险最低、验收标准最确定。

### 切片 2（MVP 验收线）

自定义 ImagesProvider → Tools → AgentHarness（注入切片 1 的 Postgres session + stdout telemetry）→ Worker → 真实出图 → 新 Revision。

多轮对话在本切片即可用——轨迹已在 PostgreSQL 里。

### 切片 3

SSE 端点，基于 `getLog({ afterSeq })` 增量推送 Agent 进展。

## 16. Non-goals

本设计不实现：

- 鉴权与用户体系（仅预埋 `owner_id`）
- 前端
- SSE / 流式（切片 3）
- 轮次自动重试与语义指纹幂等（§8.3）
- 对象存储垃圾回收
- 多模型路由与 fallback
- 成本统计与配额
- Skills / Plugins 的具体内容（仅确保挂载点可用）
- 即梦 / 通义万相等其他图像供应商适配

## 17. Risks And Assumptions

- **assumption：中转站的 `/v1/chat/completions` 支持稳定的 function calling。** 若工具调用不稳定，整个 agent 循环不成立。这是切片 2 必须最先验证的一点。
- **assumption：中转站的 `/v1/images/edits` 接受原图 + prompt 并返回可解析的 b64 或 URL。** 实际响应格式在实现 `relayGenerateImages` 时以真实响应为准。
- **assumption：中转站返回的图片 URL 若有时效，必须在轮次内立即下载并转存对象存储。** 不直接把中转站 URL 存入 `assets.uri`。
- 模型输出只能当作不可信输入，必须经过 Domain 校验；结构化输出不等于合法业务操作。
- 切片 2 的 Worker 崩溃时轨迹已入 PostgreSQL 可查，但「只尝试一次」使该轮本身不可恢复，用户需重发消息。这是明确的取舍（§8.2）。
- PostgreSQL SessionStorage 是本次最大单块工作量（800–1000 行）。若 conformance 套件暴露出 pi 契约中未文档化的语义（分支、lane 移动、seq 单调性边界），切片 1 可能超出预估。这是把它排在最前的另一个理由：早暴露。
- **open：`RELAY_TEXT_MODEL` 的具体值待定。** 该模型必须同时满足两个条件：支持 function calling（否则 agent 循环不成立），且 `input` 含 `'image'`（否则 §5.3 的自评看不到图）。选定前无法跑通切片 2，需在实施前从中转站模型清单确认。
- pi 版本 0.84.2 处于 0.x，API 可能变化。锁定精确版本，升级作为独立任务处理。
- 生图耗时受中转站影响，10 分钟整轮上限可能需要按实测调整。
- **System prompt 的效果无法在设计阶段验证。** §5.7 列的是必须覆盖的要点，不是最终文案；实际行为需要真实模型上迭代。切片 2 的验收只要求链路走通（§15），prompt 调优是随后的独立工作。
- 在生成物上迭代编辑会逐代劣化（§5.6）。MVP 接受该代价，缓解手段（从原图带全量 patch 重生）不进本次范围。

## 18. Acceptance Criteria

- `npm test` 全绿：Domain 15 个不变 + 2 个改断言（§10.3）+ Tools + Worker 轮次 + ImagesProvider
- `npm run test:integration` 全绿：真实 PostgreSQL + 真实 MinIO 全链路，**含 pi `createSessionBackendConformance` 套件**
- `npm run smoke:e2e` 跑通：用户消息 → Agent 调工具 → 中转站真实出图 → MinIO 中可见图片对象 → 新 Revision 创建且 `active_revision_id` 切换
- **Agent 轨迹可从 PostgreSQL 回放**：一轮结束后能查到该轮的全部 entries（用户消息、工具调用、参数、结果）
- 多轮对话可用：第二条消息时 Agent 能看到第一轮历史
- 基准图规则生效：连续两次 `generate_image` 时，第二次的输入图是第一次的产出（§5.6）
- 同条件重 roll 生效：同一轮内用**完全相同**的 `patch` + `renderPrompt` 调两次 `generate_image`，两次都成功且产生两条 `generations` 记录（验证 §7.2 的旧唯一约束确已删除）
- `select_candidate` 结束本轮：调用后 Agent 不再发起新的工具调用，轮次进入 `completed`
- Agent 能看到自己生成的图（`generate_image` 返回 `ImageContent`）
- 成本护栏生效：超过每轮生图上限后 Agent 转向选图
- 不可纠正错误中止整轮，不让模型空转
- `npm run smoke:e2e` 的 stdout 中可见 `pi.harness.run`、`pi.harness.tool`、`pi.ai.request`（`operation=generate_images`）三类 span，且带耗时（§11.4）
- `src/domain/photo-state.mjs` 未修改；`photo-project-service.mjs` 的改动**仅限项目锁**（§10.3），patch 校验、Revision 冲突、候选选择逻辑不动
- 一轮内可连续调用 `generate_image` 至上限而不触发 `ProjectBusyError`（验证 §10.3 的锁迁移确已完成）
- `assets.uri` 非空：生图后该行能查到对象键，且据此能从 MinIO 取回字节（验证 §6.3 的写入代码确已改）
- README 与设计文档使用同一套术语：Agent Turn / Tool / ImagesProvider / SessionStorage
