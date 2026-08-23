export function createSelectCandidateTool({ repository, turnContext }) {
  return {
    name: 'select_candidate',
    label: 'Select candidate',
    parameters: {
      type: 'object',
      properties: { generationId: { type: 'string' }, candidateId: { type: 'string' } },
      required: ['generationId', 'candidateId'],
    },
    async execute(toolCallId, params) {
      const revision = await repository.selectCandidate({
        projectId: turnContext.projectId,
        generationId: params.generationId,
        candidateId: params.candidateId,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify({ revisionId: revision.id }) }],
        details: { revisionId: revision.id },
        terminate: true,
      };
    },
  };
}
