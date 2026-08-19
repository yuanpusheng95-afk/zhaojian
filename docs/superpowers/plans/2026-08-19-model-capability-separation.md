# PhotoAgent Model Capability Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 明确分离 LanguageModel 与 ImageGenerationProvider，并为每个新生图任务持久化精确的生图模型身份，同时兼容没有模型字段的历史 Provider Job。

**Architecture:** Generation Worker 只接受带 `image_generation` capability 的 ImageGenerationProvider；语言模型只存在于架构边界，不进入当前 Worker。PostgreSQL 为 Generation Job 增加 nullable `provider_model`，新写入由 Repository 强制非空，旧数据恢复时允许模型为空。

**Tech Stack:** Node.js 22、ES Modules、node:test、PostgreSQL 16、pg、Docker Compose。

---

## 文件结构

- Create: `migrations/004_provider_models.sql` — 增加兼容旧数据的 nullable `provider_model`。
- Modify: `src/infrastructure/postgres/photo-project-repository.mjs` — 持久化、映射并校验 Provider 模型身份。
- Modify: `src/infrastructure/postgres/generation-queue.mjs` — 重领时返回内部 `providerModel`。
- Modify: `src/worker/generation-worker.mjs` — 强制 ImageGenerationProvider capability，并校验恢复模型。
- Modify: `src/worker/mock-image-provider.mjs` — 暴露明确的生图 capability、Provider 和模型名称。
- Modify: `test/generation-worker.test.mjs` — Worker capability、提交、恢复和模型不匹配测试。
- Modify: `test-integration/postgres-repository.test.mjs` — migration、Repository、Queue 和旧数据兼容测试。
- Modify: `README.md` — 说明 LanguageModel/ImageGenerationProvider 分离。
- Modify: `/Users/zzsy/Desktop/整理后的桌面/wiki/工作/项目/zhaojian/photoagent-v1-architecture.md` — 更新架构边界。
- Modify: `/Users/zzsy/Desktop/整理后的桌面/wiki/工作/项目/zhaojian/photoagent-provider-job-recovery.md` — 更新模型身份和恢复规则。
- Create: `/Users/zzsy/Desktop/整理后的桌面/wiki/工作/项目/zhaojian/photoagent-model-capabilities.md` — 记录模型能力分离决策。

### Task 1: 持久化 Provider 模型身份

**Files:**
- Create: `migrations/004_provider_models.sql`
- Modify: `src/infrastructure/postgres/photo-project-repository.mjs:233-274,540-588`
- Modify: `src/infrastructure/postgres/generation-queue.mjs:43-95`
- Test: `test-integration/postgres-repository.test.mjs:681-819`

- [ ] **Step 1: 写 migration 和 Repository 的失败测试**

把 migration 字段测试扩展为：

```js
test('migration adds persisted provider model identity', async () => {
  const result = await pool.query(`
    SELECT column_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'generation_jobs'
      AND column_name = 'provider_model'
  `);

  assert.deepEqual(result.rows, [
    { column_name: 'provider_model', is_nullable: 'YES' },
  ]);
});
```

把 Provider Job 绑定测试改成传递并断言模型：

```js
const first = await repository.recordProviderJob({
  generationId: generation.id,
  claimToken: claimed.leaseToken,
  providerName: 'mock',
  providerModel: 'mock-image-v1',
  providerJobId: 'provider_job_fixed',
});
const repeated = await repository.recordProviderJob({
  generationId: generation.id,
  claimToken: claimed.leaseToken,
  providerName: 'mock',
  providerModel: 'mock-image-v1',
  providerJobId: 'provider_job_fixed',
});

assert.equal(first.providerModel, 'mock-image-v1');
assert.deepEqual(repeated, first);
```

增加模型替换冲突断言：

```js
await assert.rejects(
  repository.recordProviderJob({
    generationId: generation.id,
    claimToken: claimed.leaseToken,
    providerName: 'mock',
    providerModel: 'mock-image-v2',
    providerJobId: 'provider_job_fixed',
  }),
  ProviderJobConflictError,
);
```

增加新写入拒绝空模型测试：

```js
await assert.rejects(
  repository.recordProviderJob({
    generationId: generation.id,
    claimToken: claimed.leaseToken,
    providerName: 'mock',
    providerModel: '',
    providerJobId: 'provider_job_missing_model',
  }),
  /requires a non-empty provider model/,
);
```

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
npm run test:integration -- --test-name-pattern="provider model identity|provider job binding"
```

如果 npm 参数不能透传，则运行：

```bash
node scripts/prepare-test-database.mjs && \
node --test --test-name-pattern="provider model identity|provider job binding" \
  test-integration/postgres-repository.test.mjs
```

Expected: FAIL，原因是 `provider_model` 字段不存在，Repository 返回值没有 `providerModel`。

- [ ] **Step 3: 增加 nullable migration**

创建 `migrations/004_provider_models.sql`：

```sql
ALTER TABLE generation_jobs
  ADD COLUMN provider_model text;
```

不要修改 `003_provider_jobs.sql`，保持已发布 migration 不可变。

- [ ] **Step 4: 最小修改 Repository**

修改 `recordProviderJob()` 签名和校验：

```js
async recordProviderJob({
  generationId,
  claimToken,
  providerName,
  providerModel,
  providerJobId,
}) {
  if (typeof providerModel !== 'string' || providerModel.trim() === '') {
    throw new TypeError('Provider job requires a non-empty provider model');
  }

  return this.#transaction(async (client) => {
    const generation = await this.#requireGeneration(client, generationId, {
      forUpdate: true,
      includeLease: true,
      includeProvider: true,
    });
    requireLease(generation, claimToken);
    // 后续状态校验、冲突判断和 UPDATE 按本任务下面的替换片段修改。
  });
}
```

幂等比较增加模型：

```js
if (
  generation.providerName === providerName &&
  generation.providerModel === providerModel &&
  generation.providerJobId === providerJobId
) {
  return providerJobFromGeneration(generation);
}
```

UPDATE 增加模型字段：

```sql
UPDATE generation_jobs
SET provider_name = $2,
    provider_model = $3,
    provider_job_id = $4,
    provider_submitted_at = $5,
    updated_at = $5
WHERE id = $1
RETURNING provider_name, provider_model,
          provider_job_id, provider_submitted_at
```

参数改为：

```js
[generationId, providerName, providerModel, providerJobId, now]
```

内部 mapper 增加：

```js
generation.providerModel = row.provider_model;
```

`providerJobFromGeneration()` 和 `mapProviderJob()` 都返回：

```js
providerModel: generation.providerModel
```

或：

```js
providerModel: row.provider_model
```

公共 `getGeneration()` 继续使用 `includeProvider = false`，不得暴露该字段。

- [ ] **Step 5: Queue 返回内部模型身份**

`claimNext()` 的 SELECT 增加：

```sql
provider_name, provider_model, provider_job_id, provider_submitted_at
```

lease 结果增加：

```js
providerModel: job.provider_model,
```

- [ ] **Step 6: 运行相关集成测试并确认 GREEN**

Run:

```bash
node scripts/prepare-test-database.mjs && \
node --test --test-name-pattern="provider model identity|provider job binding" \
  test-integration/postgres-repository.test.mjs
```

Expected: 相关测试 PASS。

- [ ] **Step 7: 提交持久化改动**

```bash
git add migrations/004_provider_models.sql \
  src/infrastructure/postgres/photo-project-repository.mjs \
  src/infrastructure/postgres/generation-queue.mjs \
  test-integration/postgres-repository.test.mjs
git diff --cached --check
git commit -m "feat: persist image provider model identity"
```

### Task 2: 强制 ImageGenerationProvider 能力边界

**Files:**
- Modify: `src/worker/generation-worker.mjs:10-131,176-184`
- Modify: `src/worker/mock-image-provider.mjs:1-19`
- Test: `test/generation-worker.test.mjs:6-137`
- Test: `test-integration/postgres-repository.test.mjs:330-349`

- [ ] **Step 1: 修改测试 Harness，表达期望接口**

Provider 改为：

```js
const provider = {
  capability: 'image_generation',
  providerName: 'mock',
  modelName: 'mock-image-v1',
  async submit(input) {
    calls.push(['submit', input]);
    return { jobId: 'provider_job_1' };
  },
  async waitForResult(input) {
    calls.push(['waitForResult', input]);
    await heartbeat();
    return [{ candidateId: 'candidate_1', assetId: 'asset_1' }];
  },
};
```

claimed Generation 增加：

```js
providerModel: providerJobId ? 'mock-image-v1' : null,
```

提交断言增加：

```js
providerName: 'mock',
providerModel: 'mock-image-v1',
providerJobId: 'provider_job_1',
```

- [ ] **Step 2: 增加拒绝普通模型的失败测试**

```js
test('worker rejects a language model adapter', () => {
  assert.throws(
    () => new GenerationWorker({
      queue: {},
      repository: {},
      provider: {
        capability: 'language',
        providerName: 'mock',
        modelName: 'mock-language-v1',
        async submit() {},
        async waitForResult() {},
      },
    }),
    /Image generation provider must implement/,
  );
});
```

- [ ] **Step 3: 增加模型不匹配恢复的失败测试**

允许 `createHarness()` 接收 `providerModel`，然后增加：

```js
test('worker fails instead of resuming a provider job from another image model', async () => {
  const { calls, worker } = createHarness({
    providerJobId: 'provider_job_existing',
    providerModel: 'mock-image-v2',
  });

  const failed = await worker.runOnce();

  assert.equal(failed.status, 'failed');
  assert.equal(calls.some(([name]) => name === 'submit'), false);
  assert.equal(calls.some(([name]) => name === 'waitForResult'), false);
  const failure = calls.find(
    ([name, input]) => name === 'transitionGeneration' && input.to === 'failed',
  );
  assert.match(failure[1].error.message, /belongs to model mock-image-v2/);
});
```

- [ ] **Step 4: 运行 Worker 单测并确认 RED**

Run:

```bash
node --test test/generation-worker.test.mjs
```

Expected: FAIL，原因是当前 Worker 仍使用泛化的 `name`，不校验 capability/model。

- [ ] **Step 5: 最小实现 ImageGenerationProvider 校验**

把私有字段改为：

```js
#imageProvider;
```

构造函数保留 `provider` 参数，但立即校验：

```js
requireImageGenerationProvider(provider);
this.#imageProvider = provider;
```

校验函数：

```js
function requireImageGenerationProvider(provider) {
  if (
    provider?.capability !== 'image_generation' ||
    typeof provider.providerName !== 'string' ||
    provider.providerName.trim() === '' ||
    typeof provider.modelName !== 'string' ||
    provider.modelName.trim() === '' ||
    typeof provider.submit !== 'function' ||
    typeof provider.waitForResult !== 'function'
  ) {
    throw new Error(
      'Image generation provider must implement capability, providerName, modelName, submit(), and waitForResult()',
    );
  }
}
```

所有调用改用 `this.#imageProvider`。

提交记录改为：

```js
await this.#repository.recordProviderJob({
  ...writeLease,
  providerName: this.#imageProvider.providerName,
  providerModel: this.#imageProvider.modelName,
  providerJobId: submission.jobId,
});
```

恢复校验：

```js
if (claimed.providerName !== this.#imageProvider.providerName) {
  throw new Error(
    `Provider job ${claimed.providerJobId} belongs to ${claimed.providerName}, not ${this.#imageProvider.providerName}`,
  );
}
if (
  claimed.providerModel !== null &&
  claimed.providerModel !== this.#imageProvider.modelName
) {
  throw new Error(
    `Provider job ${claimed.providerJobId} belongs to model ${claimed.providerModel}, not ${this.#imageProvider.modelName}`,
  );
}
```

`claimed.providerModel === null` 是历史数据兼容路径。

- [ ] **Step 6: 更新 Mock Adapter**

```js
export class MockImageProvider {
  capability = 'image_generation';
  providerName = 'mock';
  modelName = 'mock-image-v1';

  async submit({ generation }) {
    return { jobId: `mock_job_${generation.id}` };
  }

  async waitForResult({ generation }) {
    return [
      {
        candidateId: `candidate_${generation.id}`,
        assetId: `asset_${generation.id}`,
        verification: {
          identity: { status: 'pass', score: 1 },
          backgroundPreserved: { status: 'pass' },
        },
      },
    ];
  }
}
```

- [ ] **Step 7: 更新集成测试中的自定义失败 Provider**

把 Provider 失败测试中的 Adapter 改为明确的生图能力：

```js
provider: {
  capability: 'image_generation',
  providerName: 'failing',
  modelName: 'failing-image-v1',
  async submit() {
    return { jobId: 'failing_job_1' };
  },
  async waitForResult() {
    throw new Error('provider unavailable');
  },
},
```

不要把失败 Provider 改成 LanguageModel；该测试仍然验证合法生图 Adapter 的运行时失败会释放项目锁。

- [ ] **Step 8: 运行 Worker 单测并确认 GREEN**

Run:

```bash
node --test test/generation-worker.test.mjs
```

Expected: 全部 Worker 单测 PASS。

- [ ] **Step 9: 提交 Worker 能力边界**

```bash
git add src/worker/generation-worker.mjs \
  src/worker/mock-image-provider.mjs \
  test/generation-worker.test.mjs \
  test-integration/postgres-repository.test.mjs
git diff --cached --check
git commit -m "refactor: separate image generation provider capability"
```

### Task 3: 验证模型感知恢复和旧任务兼容

**Files:**
- Modify: `test-integration/postgres-repository.test.mjs:748-819`

- [ ] **Step 1: 更新现有重领恢复测试**

第一次绑定时增加模型：

```js
await repository.recordProviderJob({
  generationId: generation.id,
  claimToken: firstClaim.leaseToken,
  providerName: 'mock',
  providerModel: 'mock-image-v1',
  providerJobId: 'provider_job_existing',
});
```

恢复 Provider 改为：

```js
provider: {
  capability: 'image_generation',
  providerName: 'mock',
  modelName: 'mock-image-v1',
  async submit() {
    throw new Error('must not submit an existing provider job');
  },
  async waitForResult({ jobId }) {
    providerCalls.push(['waitForResult', jobId]);
    return [
      {
        candidateId: 'candidate_provider_resumed',
        assetId: 'asset_provider_resumed',
      },
    ];
  },
},
```

公共对象增加断言：

```js
assert.equal('providerModel' in publicGeneration, false);
```

- [ ] **Step 2: 增加历史 NULL 模型恢复测试**

创建并领取 Generation、进入 `submitted` 后，直接写入历史数据形态：

```js
await pool.query(
  `UPDATE generation_jobs
   SET provider_name = 'mock',
       provider_job_id = 'legacy_provider_job',
       provider_submitted_at = $2
   WHERE id = $1`,
  [generation.id, '2026-08-19T06:40:00.000Z'],
);
```

然后进入 `provider_processing`、等待 lease 过期，并使用：

```js
{
  capability: 'image_generation',
  providerName: 'mock',
  modelName: 'mock-image-v1',
}
```

恢复。断言：

```js
assert.equal(completed.status, 'completed');
assert.equal(submitCalls, 0);
assert.deepEqual(waitCalls, ['legacy_provider_job']);
```

- [ ] **Step 3: 运行相关集成测试**

Run:

```bash
node scripts/prepare-test-database.mjs && \
node --test --test-name-pattern="provider|reclaimed|legacy" \
  test-integration/postgres-repository.test.mjs
```

Expected: 全部相关测试 PASS。若失败，只修复测试揭示的恢复缺陷，不扩展动态路由。

- [ ] **Step 4: 运行完整单元和集成测试**

```bash
npm test
npm run test:integration
```

Expected: 0 failures。

- [ ] **Step 5: 提交恢复兼容测试**

```bash
git add test-integration/postgres-repository.test.mjs \
  src/worker/generation-worker.mjs \
  src/infrastructure/postgres/generation-queue.mjs
git diff --cached --check
git commit -m "test: cover image model job recovery"
```

如果生产文件没有变化，只 stage 测试文件。

### Task 4: 更新 README 与 Wiki

**Files:**
- Modify: `README.md`
- Modify: `/Users/zzsy/Desktop/整理后的桌面/wiki/工作/项目/zhaojian/photoagent-v1-architecture.md`
- Modify: `/Users/zzsy/Desktop/整理后的桌面/wiki/工作/项目/zhaojian/photoagent-provider-job-recovery.md`
- Create: `/Users/zzsy/Desktop/整理后的桌面/wiki/工作/项目/zhaojian/photoagent-model-capabilities.md`
- Modify: `/Users/zzsy/Desktop/整理后的桌面/wiki/工作/项目/zhaojian/index.md`
- Modify: `/Users/zzsy/Desktop/整理后的桌面/wiki/工作/项目/zhaojian/zhaojian.md`
- Modify: `/Users/zzsy/Desktop/整理后的桌面/wiki/工作/项目/zhaojian/hot.md`
- Modify: `/Users/zzsy/Desktop/整理后的桌面/wiki/工作/项目/zhaojian/log.md`

- [ ] **Step 1: 更新 README**

加入明确边界：

```text
LanguageModel：自然语言理解与 Patch 规划，不参与 Generation Worker。
ImageGenerationProvider：异步生图、Job 幂等提交和崩溃恢复。
```

Provider Job 说明改为同时持久化 Provider 和模型身份，并注明旧记录允许缺失模型。

- [ ] **Step 2: 写 Wiki 决策页**

新页面必须包含：

- 为什么不使用万能 ModelProvider；
- 两个 Port 的接口和数据流；
- 普通模型不接触 Generation/Candidate/Revision；
- 生图模型必须有 capability、providerName、modelName；
- 历史 NULL 模型兼容规则；
- `assumption`：真实 Provider 兑现幂等键；
- 后续 Edit Interpreter 独立纵切。

- [ ] **Step 3: 更新互链和日志**

在架构页、Provider Job 恢复页、项目入口、索引和 hot 页面加入新页面链接；`log.md` 追加一次 CAPTURE 记录，不删除历史记录。

- [ ] **Step 4: 检查文档**

```bash
git diff --check
rg -n "LanguageModel|ImageGenerationProvider|provider_model|assumption" \
  README.md \
  /Users/zzsy/Desktop/整理后的桌面/wiki/工作/项目/zhaojian
```

Expected: README 与 Wiki 使用同一套术语，无断链或未标记推测。

- [ ] **Step 5: 提交仓库文档**

```bash
git add README.md
git diff --cached --check
git commit -m "docs: document model capability boundaries"
```

Wiki 在仓库外，不进入 Git 提交。

### Task 5: 最终验证与评审

**Files:**
- Review: 所有本计划改动文件

- [ ] **Step 1: 运行完整验证链**

```bash
npm test
npm run test:integration
npm run check
npm run db:migrate
npm run db:migrate
docker compose config
git diff --check
git status --short --branch
```

Expected:

- 所有测试 0 failures；
- migration 连续执行两次成功；
- Compose 配置有效；
- whitespace 检查通过；
- 工作区只包含预期文档或没有未提交文件。

- [ ] **Step 2: 逐项验收**

确认：

```text
[ ] Worker 构造时拒绝 language capability
[ ] 新 Job 持久化 providerName + providerModel + jobId
[ ] 模型匹配时恢复且不重复 submit
[ ] 模型不匹配时不调用 waitForResult
[ ] 历史 NULL 模型 Job 仍可恢复
[ ] providerModel 不进入公共 Generation/HTTP
[ ] 没有新增依赖、公开 API 或动态路由
```

- [ ] **Step 3: 代码评审输出**

使用项目格式：

```text
[品味评分] 好/一般/垃圾
[致命问题] 无，或指出具体文件和行为
[改进方向] 下一阶段实现独立 Edit Interpreter 纵切，不把 LanguageModel 塞进 Generation Worker
```

- [ ] **Step 4: 确认提交历史和分支状态**

```bash
git log -6 --oneline
git status --short --branch
```

不自动合并，不推送。
