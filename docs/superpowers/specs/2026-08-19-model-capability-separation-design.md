# PhotoAgent 模型能力分离设计

日期：2026-08-19
状态：待实现

## 1. 背景

PhotoAgent 同时需要两类模型能力：

1. 普通语言模型理解用户自然语言，将编辑意图转换成结构化 Photo State Patch；
2. 生图模型异步生成图片，返回可供用户选择的 Candidate/Asset。

这两类模型的输入、输出、调用时长、幂等要求、失败恢复和计费语义均不同。把它们合并成一个带 `modelType` 分支的万能 Provider，会把特殊情况扩散到 Worker、Repository 和 Adapter。

## 2. 决策

采用两个互不继承的能力 Port：

```text
LanguageModel
└── 理解自然语言并生成结构化 Patch

ImageGenerationProvider
└── 提交异步生图任务并等待图片结果
```

不建立 `BaseModel`、`ModelProvider` 或统一的 `run()` 接口。

## 3. LanguageModel 边界

未来的 Edit Interpreter 依赖 LanguageModel：

```js
LanguageModel.interpretEdit({
  instruction,
  currentPhotoState,
})
// -> { patch, explanation? }
```

约束：

- LanguageModel 只负责理解和规划；
- 输出必须是结构化 Patch；
- Patch 必须经过现有领域校验；
- LanguageModel 不能直接修改 Photo State；
- LanguageModel 不创建 Generation、Candidate、Asset 或 Revision；
- 本纵切不实现真实 LanguageModel 或 Edit Interpreter。

## 4. ImageGenerationProvider 边界

Generation Worker 只接受生图能力：

```js
ImageGenerationProvider {
  capability: 'image_generation',
  providerName: string,
  modelName: string,

  submit({ generation, idempotencyKey })
    -> Promise<{ jobId: string }>,

  waitForResult({ generation, jobId })
    -> Promise<Candidate[]>,
}
```

约束：

- `capability` 必须精确等于 `image_generation`；
- `providerName` 和 `modelName` 必须是非空字符串；
- Generation ID 继续作为稳定供应商幂等键；
- `submit()` 必须返回非空 Job ID；
- `waitForResult()` 只返回 Candidate 数据；
- Adapter 不能创建 Revision 或修改 Project active revision。

## 5. 持久化模型身份

现有 `generation_jobs` 已持久化：

```text
provider_name
provider_job_id
provider_submitted_at
```

增加：

```text
provider_model
```

新提交的 Provider Job 必须记录：

```text
provider_name
provider_model
provider_job_id
provider_submitted_at
```

Provider Job 恢复时：

- 旧数据 `provider_model IS NULL`：只校验 `provider_name`，允许恢复；
- 新数据 `provider_model IS NOT NULL`：同时校验 `provider_name + provider_model`；
- Provider 或模型不匹配时，不查询错误的外部 Job，Generation 进入失败路径；
- Provider 元数据继续只在 Queue、Repository 和 Worker 内部流转，不进入公开 Generation 或 HTTP API。

### 5.1 向后兼容

`provider_model` 在 migration 中保持 nullable，避免伪造旧任务使用的模型名称，也避免部署后无法恢复已有 Provider Job。

Repository 对所有新 `recordProviderJob()` 调用强制要求非空 `providerModel`。因此 nullable 只服务于历史数据兼容，不允许新数据继续缺失模型身份。

保留现有数据库字段名 `provider_name`，不做破坏性重命名。`generation_jobs` 上的 Provider 字段明确表示生图 Provider。

## 6. 代码改动范围

### 6.1 Worker

- 内部字段从泛化的 `provider` 改为 `imageProvider`；
- 构造参数暂时保留 `provider` 名称，避免无价值的调用方破坏；
- Provider 校验改为 ImageGenerationProvider 能力校验；
- 提交时持久化 `providerName + modelName + jobId`；
- 恢复时校验 Provider 和具体模型。

### 6.2 Mock Adapter

Mock Adapter 暴露：

```js
capability = 'image_generation'
providerName = 'mock'
modelName = 'mock-image-v1'
```

保留现有 `MockImageProvider` 导出名称，避免无收益的兼容性破坏。未来如需改名，可增加别名后单独迁移。

### 6.3 PostgreSQL

新增 migration：

```sql
ALTER TABLE generation_jobs
  ADD COLUMN provider_model text;
```

不修改现有三字段完整性约束，因为旧 Provider Job 没有模型身份。新数据完整性由 Repository 写入口保证，并通过集成测试锁定。

### 6.4 文档

更新 README 和项目 Wiki，明确：

- LanguageModel 与 ImageGenerationProvider 是两个 Port；
- 当前实现只有 ImageGenerationProvider 纵切；
- LanguageModel/Edit Interpreter 是后续独立纵切；
- Provider 和模型身份必须持久化后才能安全恢复。

## 7. 测试策略

先写失败测试，再改生产代码。

### 单元测试

1. Worker 接受合法 ImageGenerationProvider；
2. Worker 拒绝缺少 `image_generation` capability 的普通模型；
3. Worker 提交时记录 `providerName` 和 `modelName`；
4. Worker 恢复相同 Provider/模型的 Job 时跳过 submit；
5. Worker 拒绝恢复模型不匹配的 Job。

### PostgreSQL 集成测试

1. migration 增加 `provider_model`；
2. 新 Provider Job 必须持久化模型身份；
3. 相同 Provider、模型和 Job 的重复绑定保持幂等；
4. 试图替换 Provider、模型或 Job 时触发冲突；
5. Queue 重领返回 `providerModel`；
6. 公共 Generation 和 HTTP 响应不暴露 `providerModel`；
7. `provider_model IS NULL` 的旧 Provider Job 仍可恢复。

## 8. 非目标

本纵切不实现：

- 真实语言模型调用；
- LLM Edit Interpreter；
- 新 HTTP endpoint；
- 动态模型路由；
- 多 Provider 调度；
- 模型降级或 fallback；
- 统一模型 SDK；
- 新依赖或独立微服务。

## 9. 风险与 assumption

- **assumption：真实生图 Provider 必须兑现 Generation ID 幂等键。**
- `provider_model` 是应用侧稳定模型标识，不应直接依赖供应商随时可能变化的展示名称。
- 旧任务缺少模型身份时只能按 Provider 恢复，这是兼容性妥协；所有新任务必须记录具体模型。
- 当前 V1 仍只有一个生图 Provider，动态路由必须在外部提交前持久化 Provider 和模型选择。

## 10. 验收标准

- Worker 不能误用普通语言模型 Adapter；
- 新 Provider Job 包含精确生图模型身份；
- 相同 Provider/模型的任务可以崩溃恢复且不重复 submit；
- 不匹配的 Provider/模型不会查询已有外部 Job；
- 旧 Provider Job 仍可恢复；
- HTTP 公开 API 不变；
- 单元测试、集成测试、语法检查和 migration 幂等检查全部通过。
