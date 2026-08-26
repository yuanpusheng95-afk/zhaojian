# 照见（Zhaojian）Photo Agent

PhotoAgent V1：模块化单体 API + PostgreSQL 持久化 + 租约式 SQL Job Queue + Redis Stream 事件加速 + 独立 Agent Turn Worker + 真实图像供应商。Agent 循环（LLM + 工具调用 + 图像生成）已完整接线。

## 运行时

本项目运行在 **Bun 1.3.10** 上（`package.json` 的 `engines` 字段是唯一事实来源）。
这是从 Node.js >= 22 有意迁移的结果：测试运行器（`bun test`）、脚本执行和
TypeScript 直跑都依赖 Bun，Node 不受支持。

## 已实现闭环

```text
创建 Project 与初始 Revision
→ POST /messages 提交带幂等键的用户消息，入队 Agent Turn 并锁定 Project
→ Worker 用 FOR UPDATE SKIP LOCKED 领取任务并持有租约，长任务期间心跳续租
→ Agent 循环：DeepSeek LLM + 工具调用
    read_photo_state   读取当前 Photo State
    generate_image     校验 Patch → 调真实图像供应商 → 候选图落 S3 → 记录 Generation
    select_candidate   选图并创建新 Revision
→ SSE 实时推送轮次状态（Redis Stream 加速，失败自动降级数据库轮询）
→ 用户选择 Candidate 后事务内创建新 Revision 并切换 activeRevisionId
```

关键边界：

- LLM 只能输出结构化 Patch 和渲染提示词，不能直接改 Photo State；工具层校验后才能生效。
- `Generation`、`Candidate`、`Revision` 是三个独立概念；Generation 完成不会自动创建 Revision。
- 同一项目同时只允许一个运行中的 Turn。
- 每个生成请求必须携带幂等键；过期 `baseRevisionId` 返回 Revision Conflict。
- 项目锁、幂等记录、Candidate 选择和 Revision 切换由 PostgreSQL 事务保证。
- Worker 写入必须携带领取时获得的 lease token；过期任务可重领，旧 Worker 不能继续写。
- 默认租约 30 秒、心跳 10 秒；耗尽后任务失败并释放项目锁。
- `ImageGenerationProvider` 是类型化 Port（`generate` + 类型化 `ProviderError`），当前实现为 relay adapter；新增供应商不改工具代码。

## 架构

```text
src/
├── api/                 Hono HTTP API（路由、SSE 事件流策略、访问策略端口）
├── agent/               Agent 循环 runner 与三个工具
├── domain/              Photo State、领域错误码单一来源、内存版测试替身
├── infrastructure/      Postgres repository/queue、Redis events、S3 存储、供应商 adapter、telemetry
├── worker/              Turn worker（租约、心跳、并发）
└── db/                  Drizzle schema
```

设计约定：

- **端口先行**：repository、queue、session storage、asset storage、image provider 都是接口；生产实现与测试替身共享契约。
- **错误码单一来源**：`src/domain/errors.ts` 的 `ErrorCode` 常量 + `ERROR_STATUS` 映射，业务错误类全部引用常量。
- **SSE 策略化**：`PollingEventSource` 主干 + `RedisEventSource` 加速 + 失败一次性熔断降级装饰器。
- **config zod 化**：三个 loader 共享 schema 片段，全量类型推导，fail-fast 校验。
- **访问控制接缝**：`AccessPolicy` 端口 + `OwnerOnlyAccessPolicy`；认证开启后自动强制资源归属。

## 快速开始

依赖：Bun 1.3.10、Docker。

```bash
bun install
cp .env.example .env          # 填 LLM_API_KEY / IMAGE_BASE_URL / IMAGE_API_KEY
docker compose up -d postgres minio redis
bun run db:migrate
```

启动：

```bash
bun run start:api             # http://127.0.0.1:3000
bun run start:worker
```

默认地址：

```text
API: http://127.0.0.1:3000
PostgreSQL: postgres://photo_agent:photo_agent@127.0.0.1:54329/photo_agent
Redis: redis://127.0.0.1:6379
MinIO: http://127.0.0.1:9000
```

可通过 `DATABASE_URL`、`PORT`、`REDIS_URL` 覆盖。候选图 URL 默认 900 秒有效，可用 `SIGNED_URL_TTL_SECONDS` 覆盖。

## Docker Compose 部署

```bash
cp .env.example .env          # 填写凭证
docker compose up -d --build  # 构建、迁移、启动 postgres/minio/redis/api/worker
```

`migrate` 是一次性任务，由 Compose 在数据库健康后执行；API 和 worker 等它成功后启动。前端由 API 容器直接提供，访问 `http://127.0.0.1:3000/`。本地开发可运行 `bun run dev:frontend`，Vite 会代理 API 到 `127.0.0.1:3000`。

## 最小 API

```text
POST /uploads                                       # 图片上传，Content-Type 必须 image/*，最大 20MB
POST /projects                                      # x-user-id 标识归属
GET  /projects/:id                                  # 校验归属（404 掩盖存在性）
GET  /health

# Agent turns
POST /projects/:projectId/messages                  # Idempotency-Key 必填；202 新建 / 200 重放 / 409 冲突或忙碌
GET  /projects/:projectId/turns                     # 项目轮次历史（最新在前，最多 50 条）
GET  /projects/:projectId/turns/:turnId             # 轮次详情，completed generation 带签名候选图
POST /projects/:projectId/turns/:turnId/selections  # 手动选图，成功返回 { revisionId }
GET  /projects/:projectId/turns/:turnId/events      # SSE：turn + done + error

GET /generations/:id                                # deprecated：仅供调试，不签 URL
```

`POST .../messages` 需要请求头 `Idempotency-Key` 和 JSON 体 `{ "message": "..." }`。
`POST .../selections` 需要 `{ "generationId": "...", "candidateId": "..." }`；只有 `completed` generation 可以选图。
Turn 详情和 SSE 中的 `candidate.url` 是短期签名 URL。SSE 错误事件返回 `{ code, message? }`；未知错误统一为 `INTERNAL_ERROR`。

身份说明：V1 无登录体系，`x-user-id` 请求头是身份提示而非鉴权（缺省回落 `dev`）。资源读写已按归属校验并用 404 掩盖存在性，但请求方可任意声明身份——真正的鉴权待认证落地后在 `AccessPolicy` 端口接入。

## 验证

单元测试（纯领域 + 内存替身）：

```bash
bun test test/
```

TypeScript 检查：

```bash
bun run check                    # tsc --noEmit，strict 模式
```

真实 PostgreSQL / MinIO / HTTP 集成测试（需要 `.env.test`）：

```bash
bun run test:integration
```

集成测试包含真实 MinIO 签名 URL 字节取回与 SSE 终态推送。集成测试必须串行运行：各文件共享同一测试库并在 `beforeEach` 重置 schema。

## 当前限制

- 无鉴权：`x-user-id` 可任意声明（见上文身份说明）；`AccessPolicy` 接缝已就位。
- `GET /generations/:id` deprecated，仅供本地调试，不签 URL。
- 租约只能阻止 stale worker 写数据库，不能撤销已发给真实 Provider 的外部调用。
- **assumption：真实 Provider 必须兑现 Generation ID 幂等键。** 若供应商忽略幂等键，"提交成功、Job ID 落库前"崩溃仍可能重复扣费。
- 过期任务重领会删除旧 Candidate 关联，但保留生成 Asset，后续需要垃圾回收。
