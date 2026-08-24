export function createReadPhotoStateTool({ repository, turnContext }) {
  return {
    name: 'read_photo_state',
    label: 'Read photo state',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      const revision = await repository.getRevision(
        // repository.getRevision requires an id; the worker seeds the context from
        // the active revision. For V1 the tool reads through a project-scoped adapter.
        turnContext.activeRevisionId,
      );
      const details = {
        revisionId: revision.id,
        state: revision.state,
        baseImage: {
          assetId: turnContext.currentBaseAssetId,
          ...(turnContext.currentBaseAssetId ? {} : { mode: 'text_to_image' }),
          origin: turnContext.origin,
        },
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(details) }],
        details,
      };
    },
  };
}
