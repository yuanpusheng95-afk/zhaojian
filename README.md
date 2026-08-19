# 照见（Zhaojian）Photo Agent

当前仓库正在实现 PhotoAgent V1 的最小领域核心。

## 当前里程碑

已实现纯领域层闭环：

```text
Photo State
→ State Patch
→ Generation Job
→ Candidate
→ 用户选择
→ Revision
```

核心约束：

- LLM 只能产生结构化 Patch，不能直接改状态。
- Photo State 更新不可变，并拒绝修改/保持同一路径的冲突请求。
- 同一项目同时只允许一个运行中的 Generation Job。
- Generation、Candidate 和 Revision 是三个独立概念。
- Generation 完成不会自动创建 Revision；用户选择 Candidate 后才创建。
- 所有生成请求必须携带幂等键。
- 过期 `baseRevisionId` 会触发 Revision Conflict。

## 目录

```text
src/domain/photo-state.mjs
src/domain/photo-project-service.mjs
test/photo-state.test.mjs
test/project-workflow.test.mjs
```

## 运行测试

当前实现不依赖第三方包，使用 Node.js 22 内置测试运行器：

```bash
node --test
```

## 当前边界

这是可执行的内存领域模型，不是最终持久化实现。下一步是把领域操作映射到 PostgreSQL Repository 和事务边界，再接 Generation Worker 与图像 Provider Adapter。
