# 照见（Zhaojian）Photo Agent

PhotoAgent V1 的最小可执行纵切：模块化单体 API、PostgreSQL 持久化、带租约的 SQL Job Queue、独立 Agent Turn Worker 和真实图像供应商。

## 已实现闭环

```text
创建 Project 与初始 Revision
→ 提交带幂等键的 State Patch
→ 创建 Generation Job 并锁定 Project
→ Worker 使用 FOR UPDATE SKIP LOCKED 领取任务并持有租约
→ 使用 Generation ID 作为 Provider 幂等键提交任务
→ 持久化 Provider、模型和 Job ID
→ Provider 长调用期间心跳续租
→ Mock Provider 返回 Candidate
→ 用户选择 Candidate
→ 事务内创建新 Revision 并切换 activeRevisionId
```

关键边界：

- LanguageModel 只能输出结构化 Patch，不能直接改 Photo State；当前公开客户端仍直接提交 Patch。
- EditInterpreter 是无状态 Application Service，不进入 Generation Worker。
- MockLanguageModel 通过可编程 planner 返回 Patch，不实现关键词解析。
- 解释失败返回 `EDIT_INTERPRETATION_FAILED`，不创建 Generation 或锁 Project。
- ImageGenerationProvider 负责异步生图、Job 幂等提交和崩溃恢复。
- 同一项目同时只允许一个运行中的 Generation Job。
- `Generation`、`Candidate`、`Revision` 是三个独立概念。
- Generation 完成不会自动创建 Revision；用户选择 Candidate 后才创建。
- 每个生成请求必须携带幂等键。
- 过期 `baseRevisionId` 返回 Revision Conflict。
- 项目锁、幂等记录、Candidate 选择和 Revision 切换由 PostgreSQL 事务保证。
- Worker 写入必须携带领取时获得的 lease token；过期任务可重领，旧 Worker 不能继续写。
- 默认租约 30 秒、心跳 10 秒、最多尝试 3 次；耗尽后任务失败并释放项目锁。
- Provider Job 与 Generation 一对一绑定；新任务持久化 `providerName + providerModel + providerJobId`，重领时只恢复完全匹配的 Provider/模型。
- 历史 Provider Job 允许 `providerModel` 为空；这类记录只按 Provider 匹配，避免 migration 破坏旧任务。
- Provider 名称、模型和 Job ID 只在 Queue/Worker 内部流转，不通过公共 Generation/HTTP 暴露。

## 模型能力边界

```text
用户自然语言
→ EditInterpreter
→ LanguageModel：理解意图并输出结构化 Photo State Patch
→ Domain：校验 Patch 并创建 Generation
→ ImageGenerationProvider：提交异步生图 Job 并返回 Candidate
```

两类能力是互不继承的 Port，不使用带 `modelType` 分支的万能 `ModelProvider`：

- `LanguageModel` 必须声明 `capability = language`，只负责输出 Patch。
- `ImageGenerationProvider` 必须声明 `capability = image_generation`、`providerName` 和 `modelName`。
- 两类 Adapter 不能互换；Generation Worker 构造时拒绝语言模型 Adapter。
- 当前已实现内部 EditInterpreter 和可编程 MockLanguageModel，但未接真实 LanguageModel，也未开放自然语言 HTTP API。

## 运行环境

- Node.js 22+
- Docker / Docker Compose

安装依赖并启动数据库：

```bash
npm install
cp .env.example .env      # 填 IMAGE_BASE_URL / IMAGE_API_KEY（LLM_API_KEY 待切片 2c）
npm run dev:up            # PostgreSQL + MinIO
npm run db:migrate
```

启动 API：

```bash
npm run start:api
npm run start:worker
```

默认地址：

```text
API: http://127.0.0.1:3000
PostgreSQL: postgres://photo_agent:photo_agent@127.0.0.1:54329/photo_agent
```

可通过 `DATABASE_URL`、`PORT` 覆盖。

## 最小 API

```text
POST /projects
GET  /projects/:id
GET  /generations/:id
POST /projects/:projectId/generations/:generationId/selections
GET  /health
```

## 验证

单元测试：

```bash
npm test
```

真实 PostgreSQL 集成测试：

```bash
npm run db:up
npm run test:integration
```

## Agent 冒烟

冒烟需要 `.env` 里的 LLM 与图像供应商凭证，并先创建带基准图的项目：

```bash
npm run smoke:agent -- <projectId> 把背景换成海边沙滩，保持人物面部特征不变
npm run start:worker
```

`smoke:agent` 只负责提交 Turn 并等待终态；`start:worker` 执行 Agent 循环、调用工具、生成图像并把轨迹写进 PostgreSQL。stdout 保持 JSON 行 telemetry，人类可读进度走 stderr。

测试脚本默认创建并重置独立的 `photo_agent_test` 数据库；如果数据库名不以 `_test` 结尾，会拒绝执行破坏性重置。

集成测试**必须串行**（`--test-concurrency=1`）：各测试文件共享同一个测试库并在 `beforeEach` 里 `DROP SCHEMA public CASCADE`，`node --test` 默认的多文件并行会让它们互相清库。

只跑会话后端的一致性测试：

```bash
npm run test:session
```

语法检查：

```bash
npm run check
```

## 目录

```text
migrations/                         PostgreSQL migration
src/application/                    EditInterpreter 与 Mock LanguageModel
src/domain/                         Photo State 与领域状态机
src/infrastructure/postgres/        Migration、事务 Repository、SQL Queue
src/infrastructure/postgres/session/  pi Agent 会话的 PostgreSQL 后端（SessionStorage + SessionRepo）
src/infrastructure/models/          文本与图像供应商适配
src/infrastructure/storage/         S3 兼容对象存储（MinIO / OSS / COS）
src/infrastructure/telemetry/       stdout span 输出
src/worker/                         Generation Worker 与 Mock Provider
src/api/                            原生 Node HTTP API
test/                               纯领域单元测试
test-integration/                   真实 PostgreSQL 与 HTTP 纵切测试
```

## 当前限制

- 只接 Mock ImageGenerationProvider，尚未接真实图像供应商。
- 已实现内部 EditInterpreter 和 Mock LanguageModel，尚未接真实 LanguageModel，也未开放自然语言 HTTP 入口。
- 图像供应商适配层已打通：基准图 + 指令可产出真实图片并落入 S3 兼容对象存储（`npm run smoke:image -- <图> "<指令>"`）。Agent 尚未接线（切片 2c）。
- **中转站现状（实测，`node --env-file=.env scripts/probe-providers.mjs` 可复查）**：
  - `/v1/chat/completions` + 图片 —— **唯一可靠的 img2img 路径**，图片以 Markdown data URI 内嵌在 `message.content` 里
  - `/v1/images/edits` —— 恒 502
  - `/v1/images/generations` —— **不稳定**，同样参数时通时不通（Cloudflare 502）
  - `size` 不可为 `auto`，否则上游超时
  - 供应商修好 edits 后把 `IMAGE_EDIT_ROUTE` 改为 `edits` 即可，无需改代码
- Agent 会话轨迹已可持久化到 PostgreSQL：实现了 pi 的 `SessionStorage`（17 方法）与 `SessionRepo`（5 方法，含 fork），通过官方 `createSessionBackendConformance` 全部 30 个用例。Agent 本身尚未接线（切片 2）。
- **assumption：真实入口接入前，同一消息不会并发重复解释；公开入口需要持久化 Message/EditRequest。**
- 尚未实现对象存储上传、鉴权、SSE 和前端。
- 租约只能阻止 stale worker 写数据库，不能撤销已经发给真实 Provider 的外部调用。
- Worker 已把稳定的 Generation ID 作为供应商幂等键，并持久化 Provider、模型和 Job ID。
- **assumption：真实 Provider 必须真正兑现该幂等键。** 如果供应商忽略幂等键，崩溃发生在“提交成功、Job ID 落库前”时仍可能重复扣费。
- 过期任务重领会删除旧 Candidate 关联，但当前保留其生成 Asset，后续需要垃圾回收。
