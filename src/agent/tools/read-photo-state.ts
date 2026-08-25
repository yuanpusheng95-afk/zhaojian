import type { AgentTool } from "@earendil-works/pi-agent-core";

import type { PhotoProjectRepository } from "../../domain/photo-project.js";
import type { TurnContext } from "./turn-context.js";

export function createReadPhotoStateTool({ repository, turnContext }: {
  repository: Pick<PhotoProjectRepository, "getRevision">;
  turnContext: TurnContext;
}): AgentTool<any> {
  return {
    name: "read_photo_state",
    description: "Read the current photo editing state for the active turn",
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
