# PhotoAgent Edit Interpreter 内部纵切设计

**日期：** 2026-08-19
**状态：** 已确认
**范围：** 内部 Application Service，不修改 HTTP API、数据库 schema、Generation Worker、依赖或运行配置

## 1. Context

当前 PhotoAgent 已完成两条纵切：

1. Domain、PostgreSQL、Generation Queue、Worker、Candidate 与 Revision 的生成闭环；
2. LanguageModel 与 ImageGenerationProvider 的能力边界分离，以及生图 Provider + Model + Job ID 的持久化恢复。

现有 Generation 入口只接受结构化 Photo State Patch。自然语言仍需要调用方自行转换成 Patch，因此以下产品链路尚未落地：

```text
用户自然语言
→ LanguageModel
→ 结构化 Photo State Patch
→ Domain 校验
→ Generation
```

本阶段只补齐内部 Edit Interpreter 纵切。它验证语言模型边界和 Domain 交接，不开放新的 HTTP endpoint，也不接真实 LLM。

## 2. Linus 三问

### 2.1 这是真问题还是想象的？

是真问题。当前系统只能接收 Patch，无法证明自然语言模型输出能安全进入已有 Generation 流程。

### 2.2 有没有更简单的方法？

有。新增一个无状态 Application Service，组合现有 Repository、LanguageModel Port 和 Domain Patch 校验器。无需 Message 表、解释 Worker、事件总线或动态模型路由。

### 2.3 会破坏什么？

设计要求不破坏：

- 现有 HTTP 请求和响应；
- `requestGeneration()` 的调用方式与语义；
- Generation Worker 和 ImageGenerationProvider；
- PostgreSQL schema 与 migration；
- 现有 22 个单元测试和 19 个集成测试。

## 3. Decision

采用独立 Application Service：

```text
EditInterpreter
├── Repository：读取 Revision，创建 Generation
├── LanguageModel：把消息规划为结构化 Patch
└── Domain Validator：拒绝非法 Patch
```

不采用：

- 把 LanguageModel 注入 Domain Service 或 Repository；
- 把语言解释放进 Generation Worker；
- 在统一 `ModelProvider` 中使用 `modelType` 分支；
- 先建设持久化 Message/EditRequest 状态机。

Domain 不依赖外部模型。Repository 不负责理解文本。Worker 不处理用户消息。

## 4. Port 与 Application Service

### 4.1 LanguageModel

当前纵切定义最小能力：

```js
LanguageModel {
  capability: 'language',

  planPatch({ message, photoState })
    -> Promise<PhotoStatePatch>
}
```

约束：

- `capability` 必须精确等于 `language`；
- `planPatch` 必须是函数；
- 输入 `message` 是经过非空校验的原始用户文本；
- 输入 `photoState` 是指定 base Revision 的状态副本；
- 输出必须是结构化 Photo State Patch；
- LanguageModel 不读取或写入 Repository；
- LanguageModel 不创建 Generation、Candidate 或 Revision；
- LanguageModel 不调用 ImageGenerationProvider。

本阶段不要求 LanguageModel 提供 `providerName` 或 `modelName`。没有持久化语言模型执行记录时，增加这些字段不会形成可恢复语义，只会扩大接口。

### 4.2 EditInterpreter

公开内部方法：

```js
EditInterpreter.interpretAndRequestGeneration({
  projectId,
  baseRevisionId,
  idempotencyKey,
  message,
}) -> Promise<Generation>
```

构造依赖：

```js
new EditInterpreter({
  repository,
  languageModel,
})
```

Repository 必须提供已有方法：

```js
getRevision(revisionId)
requestGeneration({
  projectId,
  baseRevisionId,
  idempotencyKey,
  patch,
  operation,
})
```

EditInterpreter 不增加 Repository Port，也不改变现有方法签名。

## 5. Data Flow

```text
interpretAndRequestGeneration(input)
→ 校验 message 是非空字符串
→ repository.getRevision(baseRevisionId)
→ languageModel.planPatch({ message, photoState: revision.state })
→ applyPhotoStatePatch(revision.state, patch) 做 Domain 预校验
→ repository.requestGeneration({
     projectId,
     baseRevisionId,
     idempotencyKey,
     patch,
     operation: 'edit'
   })
→ 返回 queued Generation
```

Domain 预校验只用于在进入 Repository 前识别模型输出错误。Repository 仍会再次应用同一 Domain 规则并维护事务、Revision Conflict、项目锁和 Generation 幂等，仍是持久化写入的权威边界。

`photoState` 必须传递副本，避免 Adapter 修改 Revision 状态。Mock LanguageModel 和测试会锁定此行为。

## 6. Failure Semantics

新增两个应用层错误：

```text
InvalidEditRequestError
code = INVALID_EDIT_REQUEST
```

触发条件：

- `message` 不是字符串；
- `message.trim()` 为空。

```text
EditInterpretationFailedError
code = EDIT_INTERPRETATION_FAILED
```

触发条件：

- `LanguageModel.planPatch()` 抛错；
- LanguageModel 返回非法 Patch；
- Patch 含不支持或不安全的路径；
- Patch 同时 modify 与 preserve 重叠路径。

失败规则：

- 不调用 `requestGeneration()`；
- 不创建 Generation；
- 不锁 Project；
- 对外错误不泄露 Provider 内部异常；
- 原始错误仅通过 `cause` 保留给内部日志或调试。

以下 Repository/Domain 工作流错误原样透传：

```text
PROJECT_NOT_FOUND
REVISION_NOT_FOUND
REVISION_CONFLICT
PROJECT_BUSY
IDEMPOTENCY_CONFLICT
INVALID_GENERATION_REQUEST
```

这些错误不属于语言解释失败，不能统一包装成 `EDIT_INTERPRETATION_FAILED`。

## 7. Mock LanguageModel

新增可编程 `MockLanguageModel`，不实现关键词解析：

```js
new MockLanguageModel({
  planner: async ({ message, photoState }) => patch,
})
```

行为：

- 固定声明 `capability = 'language'`；
- 构造时要求 `planner` 是函数；
- `planPatch()` 把输入交给 planner；
- 返回 planner 结果的结构化副本；
- 不根据中文关键词猜测 Patch；
- 不访问网络、数据库或生图 Provider。

关键词规则会把测试夹具伪装成产品智能，且无法表达歧义、上下文和 Preserve 约束，因此不采用。

## 8. Idempotency And Concurrency

Generation 创建继续使用现有 `requestGeneration()` 幂等机制：

```text
projectId + idempotencyKey + baseRevisionId + operation + patch
```

本阶段不持久化 LanguageModel 调用，因此语言解释本身不具备跨进程幂等恢复。

**assumption：内部纵切对同一用户消息只调用一次 LanguageModel。** 如果调用方重复执行相同输入，可能重复消耗语言模型调用；最终 `requestGeneration()` 仍会避免创建重复 Generation，或在模型返回不同 Patch 时触发 `IDEMPOTENCY_CONFLICT`。

这是当前无真实 HTTP/LLM 入口下的明确范围限制。接入真实 LanguageModel 和公开自然语言 API 前，应新增持久化 Message/EditRequest 纵切，使原始消息、解释结果和幂等键在模型调用前后可审计和恢复。

并发期间若 active Revision 已变化，`requestGeneration()` 必须继续抛出 `REVISION_CONFLICT`。EditInterpreter 不吞掉、不重试，也不自动基于新 Revision 重新解释。

## 9. File Layout

新增：

```text
src/application/edit-interpreter.mjs
src/application/mock-language-model.mjs
test/edit-interpreter.test.mjs
```

修改：

```text
test-integration/postgres-repository.test.mjs
README.md
docs/superpowers/plans/2026-08-19-edit-interpreter.md
/Users/zzsy/Desktop/整理后的桌面/wiki/工作/项目/zhaojian/photoagent-model-capabilities.md
/Users/zzsy/Desktop/整理后的桌面/wiki/工作/项目/zhaojian/photoagent-v1-architecture.md
/Users/zzsy/Desktop/整理后的桌面/wiki/工作/项目/zhaojian/index.md
/Users/zzsy/Desktop/整理后的桌面/wiki/工作/项目/zhaojian/zhaojian.md
/Users/zzsy/Desktop/整理后的桌面/wiki/工作/项目/zhaojian/hot.md
/Users/zzsy/Desktop/整理后的桌面/wiki/工作/项目/zhaojian/log.md
```

不修改：

```text
src/api/**
src/worker/**
migrations/**
package.json
package-lock.json
docker-compose.yml
```

## 10. Test Strategy

严格先写失败测试，再写最小实现。

### 10.1 Unit Tests

覆盖：

1. 合法 LanguageModel 输出 Patch，并调用 Repository 创建 Generation；
2. LanguageModel 收到正确的 message 和 base Revision Photo State；
3. 传给 LanguageModel 的 state 是副本，Adapter 修改它不污染 Repository Revision；
4. 空消息在读取 Revision 或调用模型前失败；
5. 构造时拒绝 ImageGenerationProvider 或缺少 `planPatch()` 的对象；
6. 模型异常包装为 `EDIT_INTERPRETATION_FAILED`；
7. 非法 Patch、危险路径和 Modify/Preserve 冲突包装为 `EDIT_INTERPRETATION_FAILED`；
8. 解释失败时不调用 `requestGeneration()`；
9. Repository 的 `REVISION_CONFLICT`、`PROJECT_BUSY` 与 `IDEMPOTENCY_CONFLICT` 原样透传。

### 10.2 PostgreSQL Integration Tests

使用真实 PostgreSQL Repository 和 Mock LanguageModel 覆盖：

1. 文本解释后创建 queued Generation；
2. Generation 保存模型返回的 Patch 和正确 proposed State；
3. 非法 Patch 不创建 Generation，也不设置 `projects.running_generation_id`；
4. 解释期间 Revision 变化后，最终创建返回 `REVISION_CONFLICT`；
5. 现有 HTTP API 响应不增加 LanguageModel 或解释元数据。

## 11. Non-goals

本纵切不实现：

- 真实 OpenAI、Anthropic 或其他 LanguageModel Adapter；
- 新 HTTP endpoint；
- 修改现有 Generation HTTP body；
- Message/EditRequest 数据表；
- LanguageModel 调用记录和成本统计；
- 澄清问题状态；
- 自动重试、fallback 或多模型路由；
- Prompt 模板管理；
- 流式输出；
- Generation Worker 修改；
- ImageGenerationProvider 修改。

## 12. Risks And Assumptions

- **assumption：真实 LanguageModel 接入前，调用方不会并发重复解释同一消息。**
- Model 输出只能被当作不可信输入，必须经过现有 Domain 校验；结构化输出不等于合法业务操作。
- Patch 预校验与 Repository 内校验会执行两次，这是当前最小、最安全的边界；不为消除一次纯内存校验而重写现有 Domain API。
- Mock LanguageModel 只证明编排和错误边界，不证明真实模型能稳定理解中文修改意图。
- 不持久化原始消息意味着当前纵切不提供对话审计；这是接入公开 API 前必须解决的下一阶段问题。

## 13. Acceptance Criteria

- LanguageModel 与 ImageGenerationProvider 不能互换；
- 用户文本可以通过 Mock LanguageModel 转换为 Patch，并创建 queued Generation；
- Domain 拒绝模型输出的非法或冲突 Patch；
- 解释失败不会创建任务或锁住 Project；
- Repository 并发与幂等错误保持原语义；
- HTTP API、数据库 schema、Worker、依赖和配置完全不变；
- 所有现有测试继续通过；
- 新单元测试和 PostgreSQL 集成测试通过；
- README 与 Wiki 使用同一套 LanguageModel/EditInterpreter/ImageGenerationProvider 术语。
