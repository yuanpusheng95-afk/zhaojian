import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";

import type { PhotoState } from "@/domain/photo-project";
import type { PhotoProjectRepository } from "@/domain/photo-project";
import type { TurnContext } from "@/agent/tools/turn-context";

export interface ReadPhotoStateDetails {
  revisionId: string;
  state: PhotoState;
  baseImage: {
    assetId: string | null;
    mode?: "text_to_image";
    origin: string;
  };
}

export function createReadPhotoStateTool({ repository, turnContext }: {
  repository: Pick<PhotoProjectRepository, "getRevision">;
  turnContext: TurnContext;
}): AgentTool<TSchema, ReadPhotoStateDetails> {
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
          ...(turnContext.currentBaseAssetId ? {} : { mode: "text_to_image" as const }),
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
