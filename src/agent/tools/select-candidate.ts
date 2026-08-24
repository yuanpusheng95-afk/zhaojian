import type { TurnContext } from "./turn-context.js";

export function createSelectCandidateTool({ repository, turnContext }: {
  repository: { selectCandidate: (args: any) => Promise<any> };
  turnContext: TurnContext;
}) {
  return {
    name: "select_candidate",
    label: "Select candidate",
    parameters: {
      type: "object",
      properties: {
        generationId: { type: "string", description: "Generation ID returned by generate_image" },
        candidateId: { type: "string", description: "Candidate ID returned by generate_image" },
      },
      required: ["generationId", "candidateId"],
    },
    async execute(_toolCallId: string, params: { generationId: string; candidateId: string }) {
      try {
        const revision = await repository.selectCandidate({
          projectId: turnContext.projectId,
          generationId: params.generationId,
          candidateId: params.candidateId,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ revisionId: revision.id }) }],
          terminate: true,
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
