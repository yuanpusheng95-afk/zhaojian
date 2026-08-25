import type { AgentTool } from "@earendil-works/pi-agent-core";

import type { PhotoProjectRepository } from "../../domain/photo-project.js";
import type { TurnContext } from "./turn-context.js";

export function createSelectCandidateTool({ repository, turnContext }: {
  repository: Pick<PhotoProjectRepository, "selectCandidate">;
  turnContext: TurnContext;
}): AgentTool<any> {
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
      const params = rawParams as { generationId: string; candidateId: string };
      try {
        const revision = await repository.selectCandidate({
          projectId: turnContext.projectId,
          generationId: params.generationId,
          candidateId: params.candidateId,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ revisionId: revision.id }) }],
          terminate: true,
          details: undefined,
        };
      } catch (error: any) {
        return {
          content: [{ type: "text" as const, text: `Selection failed: ${error.message}` }],
          isError: true,
          details: { recoverable: true },
        };
      }
    },
  };
}
