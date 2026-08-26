import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";

import type { PhotoProjectRepository } from "@/domain/photo-project";
import type { TurnContext } from "@/agent/tools/turn-context";

export interface SelectCandidateParams {
  generationId: string;
  candidateId: string;
}

export interface SelectCandidateDetails {
  recoverable?: boolean;
}

export function createSelectCandidateTool({ repository, turnContext }: {
  repository: Pick<PhotoProjectRepository, "selectCandidate">;
  turnContext: TurnContext;
}): AgentTool<TSchema, SelectCandidateDetails> {
  return {
    name: "select_candidate",
    description: "Select a generated image candidate as the new active revision",
    label: "Select candidate",
    parameters: {
      type: "object",
      properties: {
        generationId: { type: "string", description: "Generation ID returned by generate_image" },
        candidateId: { type: "string", description: "Candidate ID returned by generate_image" },
      },
      required: ["generationId", "candidateId"],
    },
    async execute(_toolCallId: string, rawParams: unknown) {
      // 库的 Static<T> 只支持 TypeBox schema；手写 JSON Schema 推不出参数类型，
      // 在入口做一次显式转换是唯一的边界妥协。
      const params = rawParams as SelectCandidateParams;
      try {
        const revision = await repository.selectCandidate({
          projectId: turnContext.projectId,
          generationId: params.generationId,
          candidateId: params.candidateId,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ revisionId: revision.id }) }],
          terminate: true,
          details: {} as SelectCandidateDetails,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Selection failed: ${(error as Error).message}` }],
          isError: true,
          details: { recoverable: true },
        };
      }
    },
  };
}
