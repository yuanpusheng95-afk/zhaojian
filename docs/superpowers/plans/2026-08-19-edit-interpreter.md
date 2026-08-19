# PhotoAgent Edit Interpreter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现内部 Edit Interpreter 纵切，把用户自然语言通过独立 LanguageModel Port 转换为结构化 Photo State Patch，经 Domain 校验后创建 Generation，同时保持 HTTP、数据库和 Generation Worker 不变。

**Architecture:** 新增无状态 `EditInterpreter` Application Service，依赖现有 Repository 和 `LanguageModel`。模型输出先经过 `applyPhotoStatePatch()` 预校验，再交给现有 `requestGeneration()` 维护事务、Revision Conflict、项目锁和幂等；新增可编程 Mock LanguageModel，但不实现关键词解析或真实 LLM Adapter。

**Tech Stack:** Node.js 22、ES Modules、node:test、PostgreSQL 16、pg、Docker Compose。

---

## 文件结构

新增：

```text
src/application/edit-interpreter.mjs       无状态文本解释编排、LanguageModel capability 校验、应用层错误
src/application/mock-language-model.mjs    可编程 Mock LanguageModel Adapter
test/edit-interpreter.test.mjs             EditInterpreter 与 Mock LanguageModel 单元测试
```

修改：

```text
test-integration/postgres-repository.test.mjs  真实 PostgreSQL 文本解释纵切和并发失败测试
README.md                                       已实现边界、目录与限制
/Users/zzsy/Desktop/整理后的桌面/wiki/工作/项目/zhaojian/photoagent-model-capabilities.md
/Users/zzsy/Desktop/整理后的桌面/wiki/工作/项目/zhaojian/photoagent-v1-architecture.md
/Users/zzsy/Desktop/整理后的桌面/wiki/工作/项目/zhaojian/index.md
/Users/zzsy/Desktop/整理后的桌面/wiki/工作/项目/zhaojian/zhaojian.md
/Users/zzsy/Desktop/整理后的桌面/wiki/工作/项目/zhaojian/hot.md
/Users/zzsy/Desktop/整理后的桌面/wiki/工作/项目/zhaojian/log.md
```

明确不修改：

```text
src/api/**
src/worker/**
migrations/**
package.json
package-lock.json
docker-compose.yml
```

### Task 1: 实现 EditInterpreter 应用边界

**Files:**
- Create: `test/edit-interpreter.test.mjs`
- Create: `src/application/edit-interpreter.mjs`
- Reference: `src/domain/photo-state.mjs`
- Reference: `src/domain/photo-project-service.mjs`

- [ ] **Step 1: 写成功路径、输入校验和能力隔离的失败测试**

创建 `test/edit-interpreter.test.mjs`，先写测试夹具和前三个测试：

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EditInterpretationFailedError,
  EditInterpreter,
  InvalidEditRequestError,
} from '../src/application/edit-interpreter.mjs';
import {
  IdempotencyConflictError,
  ProjectBusyError,
  RevisionConflictError,
} from '../src/domain/photo-project-service.mjs';

function initialState() {
  return {
    subject: {
      personId: 'person_1',
      identity: { preserve: true },
    },
    scene: { location: 'studio', background: 'gray' },
    appearance: { outfit: 'black jacket' },
    composition: { shot: 'medium' },
    constraints: [],
  };
}

function editPatch(value = 'ivory coat') {
  return {
    modify: [
      {
        path: 'appearance.outfit',
        operation: 'replace',
        value,
      },
    ],
    preserve: [
      { path: 'subject.identity', strength: 'hard' },
      { path: 'scene.background', strength: 'hard' },
    ],
  };
}

function createRepository({ requestError = null } = {}) {
  const revision = {
    id: 'revision_1',
    projectId: 'project_1',
    state: initialState(),
  };
  const calls = [];

  return {
    revision,
    calls,
    async getRevision(revisionId) {
      calls.push(['getRevision', revisionId]);
      return structuredClone(revision);
    },
    async requestGeneration(input) {
      calls.push(['requestGeneration', structuredClone(input)]);
      if (requestError) throw requestError;
      return {
        id: 'generation_1',
        status: 'queued',
        patch: structuredClone(input.patch),
      };
    },
  };
}

function createLanguageModel(planner) {
  return {
    capability: 'language',
    planPatch: planner,
  };
}

test('edit interpreter plans a patch from revision state and requests a generation', async () => {
  const repository = createRepository();
  let modelInput;
  const patch = editPatch();
  const interpreter = new EditInterpreter({
    repository,
    languageModel: createLanguageModel(async (input) => {
      modelInput = input;
      input.photoState.scene.location = 'mutated by adapter';
      return patch;
    }),
  });

  const generation = await interpreter.interpretAndRequestGeneration({
    projectId: 'project_1',
    baseRevisionId: 'revision_1',
    idempotencyKey: 'message_1',
    message: '把外套改成象牙白，保持脸和背景',
  });

  assert.equal(generation.id, 'generation_1');
  assert.equal(modelInput.message, '把外套改成象牙白，保持脸和背景');
  assert.deepEqual(modelInput.photoState.appearance, {
    outfit: 'black jacket',
  });
  assert.equal(repository.revision.state.scene.location, 'studio');
  assert.deepEqual(repository.calls, [
    ['getRevision', 'revision_1'],
    [
      'requestGeneration',
      {
        projectId: 'project_1',
        baseRevisionId: 'revision_1',
        idempotencyKey: 'message_1',
        patch,
        operation: 'edit',
      },
    ],
  ]);
});

test('edit interpreter rejects an empty message before reading state', async () => {
  const repository = createRepository();
  const interpreter = new EditInterpreter({
    repository,
    languageModel: createLanguageModel(async () => editPatch()),
  });

  await assert.rejects(
    interpreter.interpretAndRequestGeneration({
      projectId: 'project_1',
      baseRevisionId: 'revision_1',
      idempotencyKey: 'message_empty',
      message: '   ',
    }),
    InvalidEditRequestError,
  );
  assert.deepEqual(repository.calls, []);
});

test('edit interpreter rejects an image generation provider', () => {
  const repository = createRepository();

  assert.throws(
    () =>
      new EditInterpreter({
        repository,
        languageModel: {
          capability: 'image_generation',
          async planPatch() {
            return editPatch();
          },
        },
      }),
    /Language model must implement capability and planPatch/,
  );
});
```

- [ ] **Step 2: 运行定向测试并确认 RED**

Run:

```bash
node --test test/edit-interpreter.test.mjs
```

Expected: FAIL，原因是 `src/application/edit-interpreter.mjs` 不存在。

- [ ] **Step 3: 写模型失败、非法 Patch 和 Repository 错误透传测试**

继续追加到 `test/edit-interpreter.test.mjs`：

```js
test('edit interpreter wraps language model failures without creating a generation', async () => {
  const repository = createRepository();
  const providerError = new Error('upstream unavailable');
  const interpreter = new EditInterpreter({
    repository,
    languageModel: createLanguageModel(async () => {
      throw providerError;
    }),
  });

  await assert.rejects(
    interpreter.interpretAndRequestGeneration({
      projectId: 'project_1',
      baseRevisionId: 'revision_1',
      idempotencyKey: 'message_failure',
      message: '换一件白色外套',
    }),
    (error) => {
      assert.ok(error instanceof EditInterpretationFailedError);
      assert.equal(error.code, 'EDIT_INTERPRETATION_FAILED');
      assert.equal(error.cause, providerError);
      return true;
    },
  );
  assert.equal(
    repository.calls.some(([name]) => name === 'requestGeneration'),
    false,
  );
});

for (const [name, patch] of [
  ['unsupported path', {
    modify: [
      { path: 'billing.plan', operation: 'replace', value: 'premium' },
    ],
    preserve: [],
  }],
  ['unsafe path', {
    modify: [
      { path: '__proto__.polluted', operation: 'replace', value: true },
    ],
    preserve: [],
  }],
  ['modify preserve conflict', {
    modify: [
      {
        path: 'appearance.outfit',
        operation: 'replace',
        value: 'white coat',
      },
    ],
    preserve: [{ path: 'appearance.outfit', strength: 'hard' }],
  }],
]) {
  test(`edit interpreter rejects ${name} from the language model`, async () => {
    const repository = createRepository();
    const interpreter = new EditInterpreter({
      repository,
      languageModel: createLanguageModel(async () => patch),
    });

    await assert.rejects(
      interpreter.interpretAndRequestGeneration({
        projectId: 'project_1',
        baseRevisionId: 'revision_1',
        idempotencyKey: `message_${name}`,
        message: '修改照片',
      }),
      EditInterpretationFailedError,
    );
    assert.equal(
      repository.calls.some(([call]) => call === 'requestGeneration'),
      false,
    );
  });
}

for (const error of [
  new RevisionConflictError({
    projectId: 'project_1',
    expectedRevisionId: 'revision_1',
    actualRevisionId: 'revision_2',
  }),
  new ProjectBusyError('project_1', 'generation_running'),
  new IdempotencyConflictError('project_1', 'message_conflict'),
]) {
  test(`edit interpreter preserves repository error ${error.code}`, async () => {
    const repository = createRepository({ requestError: error });
    const interpreter = new EditInterpreter({
      repository,
      languageModel: createLanguageModel(async () => editPatch()),
    });

    await assert.rejects(
      interpreter.interpretAndRequestGeneration({
        projectId: 'project_1',
        baseRevisionId: 'revision_1',
        idempotencyKey: 'message_conflict',
        message: '换一件白色外套',
      }),
      (received) => received === error,
    );
  });
}
```

- [ ] **Step 4: 实现最小 EditInterpreter**

创建 `src/application/edit-interpreter.mjs`：

```js
import { applyPhotoStatePatch } from '../domain/photo-state.mjs';

export class InvalidEditRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidEditRequestError';
    this.code = 'INVALID_EDIT_REQUEST';
  }
}

export class EditInterpretationFailedError extends Error {
  constructor(cause) {
    super('Language model could not produce a valid photo state patch', {
      cause,
    });
    this.name = 'EditInterpretationFailedError';
    this.code = 'EDIT_INTERPRETATION_FAILED';
  }
}

export class EditInterpreter {
  #repository;
  #languageModel;

  constructor({ repository, languageModel }) {
    requireRepository(repository);
    requireLanguageModel(languageModel);
    this.#repository = repository;
    this.#languageModel = languageModel;
  }

  async interpretAndRequestGeneration({
    projectId,
    baseRevisionId,
    idempotencyKey,
    message,
  }) {
    if (typeof message !== 'string' || message.trim() === '') {
      throw new InvalidEditRequestError(
        'Edit request requires a non-empty message',
      );
    }

    const revision = await this.#repository.getRevision(baseRevisionId);
    let patch;
    try {
      patch = await this.#languageModel.planPatch({
        message,
        photoState: structuredClone(revision.state),
      });
      applyPhotoStatePatch(revision.state, patch);
    } catch (error) {
      throw new EditInterpretationFailedError(error);
    }

    return this.#repository.requestGeneration({
      projectId,
      baseRevisionId,
      idempotencyKey,
      patch,
      operation: 'edit',
    });
  }
}

function requireRepository(repository) {
  if (
    typeof repository?.getRevision !== 'function' ||
    typeof repository.requestGeneration !== 'function'
  ) {
    throw new TypeError(
      'Edit interpreter repository must implement getRevision() and requestGeneration()',
    );
  }
}

function requireLanguageModel(languageModel) {
  if (
    languageModel?.capability !== 'language' ||
    typeof languageModel.planPatch !== 'function'
  ) {
    throw new TypeError(
      'Language model must implement capability and planPatch()',
    );
  }
}
```

- [ ] **Step 5: 运行单元测试并确认 GREEN**

Run:

```bash
node --test test/edit-interpreter.test.mjs
npm test
```

Expected: 新 EditInterpreter 测试全部通过，完整单元测试 0 failures。

- [ ] **Step 6: 提交 EditInterpreter**

```bash
git add src/application/edit-interpreter.mjs test/edit-interpreter.test.mjs
git diff --cached --check
git commit -m "feat: add edit interpreter application service"
```

### Task 2: 实现可编程 Mock LanguageModel

**Files:**
- Modify: `test/edit-interpreter.test.mjs`
- Create: `src/application/mock-language-model.mjs`

- [ ] **Step 1: 写 Mock LanguageModel 的失败测试**

在 `test/edit-interpreter.test.mjs` 增加 import：

```js
import { MockLanguageModel } from '../src/application/mock-language-model.mjs';
```

追加测试：

```js
test('mock language model delegates to its planner and clones the patch result', async () => {
  const plannedPatch = editPatch();
  let plannerInput;
  const model = new MockLanguageModel({
    planner: async (input) => {
      plannerInput = input;
      return plannedPatch;
    },
  });
  const input = {
    message: '换一件象牙白外套',
    photoState: initialState(),
  };

  const result = await model.planPatch(input);

  assert.equal(model.capability, 'language');
  assert.equal(plannerInput, input);
  assert.deepEqual(result, plannedPatch);
  assert.notEqual(result, plannedPatch);
  result.modify[0].value = 'mutated result';
  assert.equal(plannedPatch.modify[0].value, 'ivory coat');
});

test('mock language model requires a planner function', () => {
  assert.throws(
    () => new MockLanguageModel({ planner: null }),
    /Mock language model requires a planner function/,
  );
});
```

- [ ] **Step 2: 运行定向测试并确认 RED**

Run:

```bash
node --test --test-name-pattern="mock language model" test/edit-interpreter.test.mjs
```

Expected: FAIL，原因是 `src/application/mock-language-model.mjs` 不存在。

- [ ] **Step 3: 实现最小 Mock Adapter**

创建 `src/application/mock-language-model.mjs`：

```js
export class MockLanguageModel {
  capability = 'language';
  #planner;

  constructor({ planner }) {
    if (typeof planner !== 'function') {
      throw new TypeError(
        'Mock language model requires a planner function',
      );
    }
    this.#planner = planner;
  }

  async planPatch(input) {
    const patch = await this.#planner(input);
    return structuredClone(patch);
  }
}
```

- [ ] **Step 4: 运行测试并确认 GREEN**

Run:

```bash
node --test test/edit-interpreter.test.mjs
npm test
```

Expected: EditInterpreter 与 Mock LanguageModel 测试全部通过，完整单元测试 0 failures。

- [ ] **Step 5: 提交 Mock Adapter**

```bash
git add src/application/mock-language-model.mjs test/edit-interpreter.test.mjs
git diff --cached --check
git commit -m "test: add programmable language model adapter"
```

### Task 3: 验证真实 PostgreSQL 解释纵切

**Files:**
- Modify: `test-integration/postgres-repository.test.mjs`
- Reference: `src/application/edit-interpreter.mjs`
- Reference: `src/application/mock-language-model.mjs`

- [ ] **Step 1: 增加 Application Service imports**

在 `test-integration/postgres-repository.test.mjs` 的领域 import 后增加：

```js
import {
  EditInterpretationFailedError,
  EditInterpreter,
} from '../src/application/edit-interpreter.mjs';
import { MockLanguageModel } from '../src/application/mock-language-model.mjs';
```

- [ ] **Step 2: 写成功路径集成测试**

追加：

```js
test('edit interpreter creates a persisted generation from a language model patch', async () => {
  const repository = createRepository();
  const project = await createProject(repository);
  let modelInput;
  const interpreter = new EditInterpreter({
    repository,
    languageModel: new MockLanguageModel({
      planner: async (input) => {
        modelInput = input;
        return editPatch('white linen coat');
      },
    }),
  });

  const generation = await interpreter.interpretAndRequestGeneration({
    projectId: project.id,
    baseRevisionId: project.activeRevisionId,
    idempotencyKey: 'language-edit-1',
    message: '换成白色亚麻外套，保持人物和背景',
  });
  const persisted = await repository.getGeneration(generation.id);

  assert.equal(generation.status, 'queued');
  assert.equal(modelInput.message, '换成白色亚麻外套，保持人物和背景');
  assert.deepEqual(modelInput.photoState, initialState());
  assert.deepEqual(persisted.patch, editPatch('white linen coat'));
  assert.equal(persisted.proposedState.appearance.outfit, 'white linen coat');
  assert.deepEqual(persisted.proposedState.constraints, [
    { path: 'subject.identity', strength: 'hard', source: 'user' },
    { path: 'scene.background', strength: 'hard', source: 'user' },
  ]);
});
```

- [ ] **Step 3: 写非法 Patch 不落库测试**

追加：

```js
test('edit interpreter does not persist or lock a generation for an invalid model patch', async () => {
  const repository = createRepository();
  const project = await createProject(repository);
  const interpreter = new EditInterpreter({
    repository,
    languageModel: new MockLanguageModel({
      planner: async () => ({
        modify: [
          {
            path: 'account.balance',
            operation: 'replace',
            value: 0,
          },
        ],
        preserve: [],
      }),
    }),
  });

  await assert.rejects(
    interpreter.interpretAndRequestGeneration({
      projectId: project.id,
      baseRevisionId: project.activeRevisionId,
      idempotencyKey: 'language-edit-invalid',
      message: '执行非法修改',
    }),
    EditInterpretationFailedError,
  );

  const generationCount = await pool.query(
    'SELECT count(*)::int AS count FROM generation_jobs',
  );
  const persistedProject = await repository.getProject(project.id);
  assert.equal(generationCount.rows[0].count, 0);
  assert.equal(persistedProject.runningGenerationId, null);
});
```

- [ ] **Step 4: 写解释期间 Revision 变化测试**

追加：

```js
test('edit interpreter preserves revision conflict when state changes during planning', async () => {
  const repository = createRepository();
  const project = await createProject(repository);
  const interpreter = new EditInterpreter({
    repository,
    languageModel: new MockLanguageModel({
      planner: async () => {
        await pool.query(
          `INSERT INTO photo_revisions
            (id, project_id, parent_revision_id, state_json, anchor_asset_id,
             source_generation_id, created_at)
           VALUES ($1, $2, $3, $4, $5, NULL, $6)`,
          [
            'revision_concurrent',
            project.id,
            project.activeRevisionId,
            {
              ...initialState(),
              appearance: { outfit: 'concurrent coat' },
            },
            'asset_source',
            '2026-08-19T06:41:00.000Z',
          ],
        );
        await pool.query(
          `UPDATE projects
           SET active_revision_id = $2, updated_at = $3
           WHERE id = $1`,
          [
            project.id,
            'revision_concurrent',
            '2026-08-19T06:41:00.000Z',
          ],
        );
        return editPatch('planned coat');
      },
    }),
  });

  await assert.rejects(
    interpreter.interpretAndRequestGeneration({
      projectId: project.id,
      baseRevisionId: project.activeRevisionId,
      idempotencyKey: 'language-edit-stale',
      message: '换一件新外套',
    }),
    RevisionConflictError,
  );

  const generationCount = await pool.query(
    'SELECT count(*)::int AS count FROM generation_jobs',
  );
  assert.equal(generationCount.rows[0].count, 0);
});
```

- [ ] **Step 5: 运行定向和完整集成测试**

Run:

```bash
node scripts/prepare-test-database.mjs && \
node --test --test-name-pattern="edit interpreter" \
  test-integration/postgres-repository.test.mjs
npm run test:integration
```

Expected: 3 个新增 Edit Interpreter PostgreSQL 测试通过，完整集成测试 0 failures；原 HTTP 测试继续通过，响应不出现 LanguageModel 或解释元数据。

- [ ] **Step 6: 提交 PostgreSQL 集成覆盖**

```bash
git add test-integration/postgres-repository.test.mjs
git diff --cached --check
git commit -m "test: cover edit interpretation persistence flow"
```

### Task 4: 更新 README 与 Wiki

**Files:**
- Modify: `README.md`
- Modify: `/Users/zzsy/Desktop/整理后的桌面/wiki/工作/项目/zhaojian/photoagent-model-capabilities.md`
- Modify: `/Users/zzsy/Desktop/整理后的桌面/wiki/工作/项目/zhaojian/photoagent-v1-architecture.md`
- Modify: `/Users/zzsy/Desktop/整理后的桌面/wiki/工作/项目/zhaojian/index.md`
- Modify: `/Users/zzsy/Desktop/整理后的桌面/wiki/工作/项目/zhaojian/zhaojian.md`
- Modify: `/Users/zzsy/Desktop/整理后的桌面/wiki/工作/项目/zhaojian/hot.md`
- Modify: `/Users/zzsy/Desktop/整理后的桌面/wiki/工作/项目/zhaojian/log.md`

- [ ] **Step 1: 更新 README 已实现边界**

把模型能力段落更新为：

```text
用户自然语言
→ EditInterpreter
→ LanguageModel：理解意图并输出结构化 Photo State Patch
→ Domain：校验 Patch 并创建 Generation
→ ImageGenerationProvider：提交异步生图 Job 并返回 Candidate
```

增加以下说明：

```text
- EditInterpreter 是无状态 Application Service，不进入 Generation Worker。
- MockLanguageModel 通过可编程 planner 返回 Patch，不实现关键词解析。
- 解释失败返回 EDIT_INTERPRETATION_FAILED，不创建 Generation 或锁 Project。
- 当前内部纵切未开放自然语言 HTTP API，也未接真实 LanguageModel。
```

目录增加：

```text
src/application/                    EditInterpreter 与 Mock LanguageModel
```

“当前限制”改为：

```text
- 已实现内部 EditInterpreter 和 Mock LanguageModel，尚未接真实 LanguageModel，也未开放自然语言 HTTP 入口。
- assumption：真实入口接入前，同一消息不会并发重复解释；公开入口需要持久化 Message/EditRequest。
```

- [ ] **Step 2: 更新 Wiki 模型能力页**

在 `photoagent-model-capabilities.md` 增加“Edit Interpreter 已实现”段落：

```text
message + baseRevisionId
→ EditInterpreter 读取 Revision State
→ LanguageModel.planPatch()
→ Domain 预校验
→ Repository.requestGeneration()
```

记录：

- LanguageModel capability 为 `language`；
- ImageGenerationProvider capability 为 `image_generation`；
- 两类 Adapter 不能互换；
- 非法 Patch 统一变成 `EDIT_INTERPRETATION_FAILED`；
- Repository 的 Revision/Busy/Idempotency 错误保持原语义；
- **assumption：真实 LanguageModel 接入前，同一消息不会并发重复解释。**

把后续项从“实现 Edit Interpreter”改为“持久化 Message/EditRequest，并接真实 LanguageModel”。

- [ ] **Step 3: 更新架构页和项目入口**

在 `photoagent-v1-architecture.md` 的 Implementation Status 追加：

```text
已完成内部 EditInterpreter 纵切：自然语言经 Mock LanguageModel 输出 Patch，Domain 校验后创建 Generation；HTTP API、数据库和 Generation Worker 保持不变。
```

在 `index.md` 和 `zhaojian.md` 的模型能力链接描述中加入 EditInterpreter 已实现状态。

- [ ] **Step 4: 更新 hot 与 log**

执行：

```bash
TS=$(date -Iseconds)
```

把 `hot.md` 的 `updated` 改为 `$TS`，Recent Activity 保留最近 3 条并把本次同步放在第一条：

```text
实现内部 EditInterpreter：Mock LanguageModel 把用户文本规划为 Patch，Domain 拒绝非法输出，现有 HTTP/Worker 边界不变。
```

Key Takeaways 加入：

```text
EditInterpreter 只做编排；LanguageModel 输出是不可信输入，必须经过 Domain 校验。
```

向 `log.md` 追加：

```text
- [$TS] UPDATE type=implementation page="工作/项目/zhaojian/photoagent-model-capabilities.md" title="PhotoAgent 语言模型与生图模型能力边界"
```

不得删除旧日志。

- [ ] **Step 5: 检查 README 与 Wiki**

Run:

```bash
git diff --check
rg -n "EditInterpreter|LanguageModel|ImageGenerationProvider|EDIT_INTERPRETATION_FAILED|assumption" \
  README.md \
  /Users/zzsy/Desktop/整理后的桌面/wiki/工作/项目/zhaojian
```

再运行本地 Wiki 链接检查：

```bash
python3 - <<'PY'
from pathlib import Path
import re

root = Path('/Users/zzsy/Desktop/整理后的桌面/wiki/工作/项目/zhaojian')
files = [
    root / 'photoagent-model-capabilities.md',
    root / 'photoagent-v1-architecture.md',
    root / 'index.md',
    root / 'zhaojian.md',
    root / 'hot.md',
]
missing = []
for path in files:
    for target in re.findall(r'\[\[([^\]|#]+)', path.read_text()):
        if not (root / f'{target}.md').exists():
            missing.append((path.name, target))
if missing:
    raise SystemExit(f'broken local wikilinks: {missing}')
print(f'wiki link check passed: {len(files)} files')
PY
```

Expected: README 与 Wiki 术语一致，本地 wikilink 无断链。

- [ ] **Step 6: 提交仓库文档**

```bash
git add README.md
git diff --cached --check
git commit -m "docs: document edit interpreter boundary"
```

Wiki 位于仓库外，不进入 Git 提交。

### Task 5: 最终验证与代码评审

**Files:**
- Review: 本计划涉及的所有仓库文件

- [ ] **Step 1: 运行完整验证链**

Run:

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

- 所有单元测试 0 failures；
- 所有 PostgreSQL/HTTP 集成测试 0 failures；
- migration 连续执行两次成功；
- Compose 配置有效；
- whitespace 检查通过；
- 工作区干净。

- [ ] **Step 2: 检查禁止改动范围**

以设计提交 `0d62977` 为基线运行：

```bash
git diff --exit-code 0d62977..HEAD -- \
  src/api \
  src/worker \
  migrations \
  package.json \
  package-lock.json \
  docker-compose.yml
```

Expected: 无输出、退出码 0，证明没有修改公开 HTTP、Worker、migration、依赖或配置。

- [ ] **Step 3: 逐项验收**

确认：

```text
[ ] LanguageModel 与 ImageGenerationProvider 不能互换
[ ] 合法文本通过 Mock LanguageModel 创建 queued Generation
[ ] 模型收到指定 Revision 的 Photo State 副本
[ ] 模型异常与非法 Patch 返回 EDIT_INTERPRETATION_FAILED
[ ] 解释失败不创建 Generation、不锁 Project
[ ] REVISION_CONFLICT / PROJECT_BUSY / IDEMPOTENCY_CONFLICT 原样透传
[ ] HTTP API、数据库 schema 和 Generation Worker 未修改
[ ] 没有新增依赖、配置或动态模型路由
```

- [ ] **Step 4: 代码评审输出**

使用项目格式：

```text
[品味评分] 好/一般/垃圾
[致命问题] 无，或指出具体文件和行为
[改进方向] 下一纵切持久化 Message/EditRequest，再接真实 LanguageModel；不要把真实模型调用直接挂到 HTTP 请求而没有解释幂等和审计
```

- [ ] **Step 5: 确认提交历史和分支状态**

```bash
git log -8 --oneline
git status --short --branch
```

不自动合并，不推送。
