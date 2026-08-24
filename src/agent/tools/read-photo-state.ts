import type { TurnContext } from "./turn-context.js";

export function createReadPhotoStateTool({ repository, turnContext }: {
  repository: { getRevision: (id: string) => Promise<any> };
  turnContext: TurnContext;
}) {
  return {
    name: "read_photo_state",
    label: "Read photo state",
    parameters: { type: "object", properties: {}, required: [] },
    async execute() {
      const revision = await repository.getRevision(turnContext.activeRevisionId);
      const details = {
        revisionId: revision.id,
        state: revision.state,
        baseImage: {
          assetId: turnContext.currentBaseAssetId,
          ...(turnContext.currentBaseAssetId ? {} : { mode: "text_to_image" }),
          origin: turnContext.origin,
        },
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(details) }],
        details,
      };
    },
  };
}
