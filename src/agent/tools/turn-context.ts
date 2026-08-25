export class MaxImagesReachedError extends Error {
  code = "MAX_IMAGES_REACHED" as const;
  constructor(limit: number) {
    super(`Maximum images per turn reached: ${limit}`);
    this.name = this.constructor.name;
  }
}

export class MaxImageAttemptsReachedError extends Error {
  code = "MAX_IMAGE_ATTEMPTS_REACHED" as const;
  constructor(limit: number) {
    super(`Maximum image generation attempts per turn reached: ${limit}`);
    this.name = this.constructor.name;
  }
}

export interface TurnContext {
  projectId: string;
  ownerId: string;
  turnId: string;
  currentBaseAssetId: string | null;
  activeRevisionId: string;
  origin: string;
  imageCount: number;
  imageAttempts: number;
  fatal: null | { code: string; message: string; name?: string; error?: unknown };
  noteAttempt(): number;
  noteImage(): number;
  advanceBase(assetId: string): void;
  setFatal(code: string, error?: unknown): NonNullable<TurnContext["fatal"]>;
}

export function createTurnContext({ projectId, ownerId, turnId, initialBaseAssetId, activeRevisionId }: {
  projectId: string; ownerId: string; turnId: string; initialBaseAssetId: string | null; activeRevisionId: string;
}): TurnContext {
  if (!projectId) throw new TypeError("createTurnContext requires projectId");
  if (!ownerId) throw new TypeError("createTurnContext requires ownerId");
  if (!turnId) throw new TypeError("createTurnContext requires turnId");
  if (!activeRevisionId) throw new TypeError("createTurnContext requires activeRevisionId");

  return {
    projectId,
    ownerId,
    turnId,
    currentBaseAssetId: initialBaseAssetId,
    activeRevisionId,
    origin: initialBaseAssetId ? "revision_anchor" : "text_to_image",
    imageCount: 0,
    imageAttempts: 0,
    fatal: null,
    noteAttempt() {
      this.imageAttempts += 1;
      return this.imageAttempts;
    },
    noteImage() {
      this.imageCount += 1;
      return this.imageCount;
    },
    advanceBase(assetId: string) {
      this.currentBaseAssetId = assetId;
      this.origin = "turn_candidate";
    },
    setFatal(code: string, error?: unknown) {
      const err = error instanceof Error ? error : undefined;
      this.fatal = {
        code,
        message: err?.message ?? String(error),
        ...(err ? { name: err.name } : {}),
      };
      this.fatal!.error = error;
      return this.fatal!;
    },
  };
}
