import { createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export function createLlmModels({ baseUrl, modelId }: { baseUrl: string; modelId: string }) {
  const models = createModels();
  models.setProvider(
    createProvider({
      id: "deepseek",
      name: "DeepSeek",
      baseUrl,
      auth: { apiKey: envApiKeyAuth("DeepSeek API key", ["LLM_API_KEY"]) },
      models: [
        {
          id: modelId,
          name: modelId,
          api: "openai-completions",
          provider: "deepseek",
          baseUrl,
          reasoning: false,
          input: ["text", "image"],
          contextWindow: 128_000,
          maxTokens: 8192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        } as any,
      ],
      api: openAICompletionsApi(),
    }) as any,
  );
  return models;
}
