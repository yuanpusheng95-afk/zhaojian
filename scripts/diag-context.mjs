import { buildSessionContext } from '@earendil-works/pi-agent-core';
import pg from 'pg';
import { createPostgresSessionRepo } from '../src/infrastructure/postgres/session/repo.js';
import { createLlmModels } from '../src/infrastructure/models/llm-provider.js';
import { loadWorkerConfig } from '../src/config.js';
import { SYSTEM_PROMPT } from '../src/agent/system-prompt.js';

const config = loadWorkerConfig(process.env);
const pool = new pg.Pool({ connectionString: config.databaseUrl });
const repo = createPostgresSessionRepo({ pool });
const session = await repo.open({ id: 'project:smoke_agent_1' });
const entries = (await session.findEntriesOnBranch()).slice().sort((a, b) => a.seq - b.seq);
console.error(`entries: ${entries.length}`);
const context = buildSessionContext(entries, {
  entryProjectors: { tool_results: (e) => Array.isArray(e.data) ? e.data : [] },
});
const messages = context.messages;
console.error('message sequence:');
for (const [i, m] of messages.entries()) {
  const kinds = (m.content ?? []).map((b) => b.type).join(',');
  console.error(`  ${i}: ${m.role} [${kinds}] stop=${m.stopReason ?? ''} ${m.content?.[0]?.text?.slice(0, 60) ?? ''}`);
}
const llm = createLlmModels(config.llm);
const model = llm.getModel('deepseek', config.llm.modelId);
const stream = llm.streamSimple(model, { systemPrompt: SYSTEM_PROMPT, messages: [...messages, { role: 'user', content: [{ type: 'text', text: '继续:把背景换成海边沙滩' }], timestamp: Date.now() }] });
for await (const event of stream) {
  if (event.type === 'done') {
    console.error('DONE stopReason:', event.reason, '| errorMessage:', event.message?.errorMessage ?? 'none');
    console.error('content blocks:', (event.message?.content ?? []).length);
  }
}
await pool.end();
