import { createModels, createProvider, envApiKeyAuth } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

/**
 * 文本模型接线（Agent 的大脑）。
 *
 * **不用 pi 内置的 deepseekProvider()**——pi 的模型目录是构建时从供应商拉取
 * 生成的，实验版模型不在快照里，getModel() 会返回 undefined。手写 Model
 * 字面量，把能力显式声明出来（设计文档 §4.1）。
 *
 * input 必须含 'image'：Agent 要看见生成���图做自评（§5.4）。
 */
export function createLlmModels({ baseUrl, modelId }) {
  const models = createModels();
  models.setProvider(
    createProvider({
      id: 'deepseek',
      name: 'DeepSeek',
      baseUrl,
      auth: { apiKey: envApiKeyAuth('DeepSeek API key', ['LLM_API_KEY']) },
      models: [
        {
          id: modelId,
          name: modelId,
          api: 'openai-completions',
          provider: 'deepseek',
          baseUrl,
          reasoning: false,
          input: ['text', 'image'],
          contextWindow: 128_000,
          maxTokens: 8192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      api: openAICompletionsApi(),
    }),
  );
  return models;
}
