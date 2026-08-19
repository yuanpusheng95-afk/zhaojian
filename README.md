# 照见（Zhaojian）Photo Agent

PhotoAgent V1 的最小可执行纵切：模块化单体 API、PostgreSQL 持久化、带租约的 SQL Job Queue、独立 Generation Worker 和 Mock Image Provider。

## 已实现闭环

```text
创建 Project 与初始 Revision
→ 提交带幂等键的 State Patch
→ 创建 Generation Job 并锁定 Project
→ Worker 使用 FOR UPDATE SKIP LOCKED 领取任务并持有租约
→ 使用 Generation ID 作为 Provider 幂等键提交任务
→ 持久化 Provider Job ID
→ Provider 长调用期间心跳续租
→ Mock Provider 返回 Candidate
→ 用户选择 Candidate
→ 事务内创建新 Revision 并切换 activeRevisionId
```

关键边界：

- LLM/客户端只能提交结构化 Patch，不能直接改 Photo State。
- 同一项目同时只允许一个运行中的 Generation Job。
- `Generation`、`Candidate`、`Revision` 是三个独立概念。
- Generation 完成不会自动创建 Revision；用户选择 Candidate 后才创建。
- 每个生成请求必须携带幂等键。
- 过期 `baseRevisionId` 返回 Revision Conflict。
- 项目锁、幂等记录、Candidate 选择和 Revision 切换由 PostgreSQL 事务保证。
- Worker 写入必须携带领取时获得的 lease token；过期任务可重领，旧 Worker 不能继续写。
- 默认租约 30 秒、心跳 10 秒、最多尝试 3 次；耗尽后任务失败并释放项目锁。
- Provider Job 与 Generation 一对一绑定；重领任务会恢复已有 Job，不重复 submit。
- Provider Job ID 只在 Queue/Worker 内部流转，不通过 HTTP 暴露。

## 运行环境

- Node.js 22+
- Docker / Docker Compose

安装依赖并启动数据库：

```bash
npm install
npm run db:up
npm run db:migrate
```

启动 API 和 Worker（两个终端）：

```bash
npm run start:api
npm run start:worker
```

默认地址：

```text
API: http://127.0.0.1:3000
PostgreSQL: postgres://photo_agent:photo_agent@127.0.0.1:54329/photo_agent
```

可通过 `DATABASE_URL`、`PORT`、`WORKER_POLL_INTERVAL_MS` 覆盖。

## 最小 API

```text
POST /projects
GET  /projects/:id
POST /projects/:id/generations
GET  /generations/:id
POST /projects/:projectId/generations/:generationId/selections
GET  /health
```

创建 Generation 时通过请求头传幂等键：

```http
Idempotency-Key: edit-1
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

测试脚本默认创建并重置独立的 `photo_agent_test` 数据库；如果数据库名不以 `_test` 结尾，会拒绝执行破坏性重置。

语法检查：

```bash
npm run check
```

## 目录

```text
migrations/                         PostgreSQL migration
src/domain/                         Photo State 与领域状态机
src/infrastructure/postgres/        Migration、事务 Repository、SQL Queue
src/worker/                         Generation Worker 与 Mock Provider
src/api/                            原生 Node HTTP API
test/                               纯领域单元测试
test-integration/                   真实 PostgreSQL 与 HTTP 纵切测试
```

## 当前限制

- 只接 Mock Image Provider，尚未接真实图像供应商。
- 尚未实现对象存储上传、鉴权、SSE、LLM Edit Parser 和前端。
- 租约只能阻止 stale worker 写数据库，不能撤销已经发给真实 Provider 的外部调用。
- Worker 已把稳定的 Generation ID 作为供应商幂等键，并持久化 Provider Job ID。
- **assumption：真实 Provider 必须真正兑现该幂等键。** 如果供应商忽略幂等键，崩溃发生在“提交成功、Job ID 落库前”时仍可能重复扣费。
- 过期任务重领会删除旧 Candidate 关联，但当前保留其生成 Asset，后续需要垃圾回收。
