export class MaxImagesReachedError extends Error {
  constructor(limit) {
    super(`Maximum images per turn reached: ${limit}`);
    this.name = this.constructor.name;
    this.code = 'MAX_IMAGES_REACHED';
  }
}

/** 与配额(只数成功)独立的尝试上限:瞬时失败的重试循环烧真钱,这里兜底。 */
export class MaxImageAttemptsReachedError extends Error {
  constructor(limit) {
    super(`Maximum image generation attempts per turn reached: ${limit}`);
    this.name = this.constructor.name;
    this.code = 'MAX_IMAGE_ATTEMPTS_REACHED';
  }
}

export function createTurnContext({ projectId, turnId, initialBaseAssetId, activeRevisionId }) {
  if (!projectId) throw new TypeError('createTurnContext requires projectId');
  // turnId 必填：recordGeneration 靠它过 FK，assetId 靠它跨轮去重。
  // 此前解构静默丢弃该参数，真实路径上生成 undefined——单测的 fake repo 不校验才没暴露
  if (!turnId) throw new TypeError('createTurnContext requires turnId');
  if (!activeRevisionId) throw new TypeError('createTurnContext requires activeRevisionId');

  return {
    projectId,
    turnId,
    currentBaseAssetId: initialBaseAssetId,
    activeRevisionId,
    origin: initialBaseAssetId ? 'revision_anchor' : 'text_to_image',
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
    advanceBase(assetId) {
      this.currentBaseAssetId = assetId;
      this.origin = 'turn_candidate';
    },
    setFatal(code, error) {
      this.fatal = {
        code,
        message: error?.message ?? String(error),
        ...(error instanceof Error ? { name: error.name } : {}),
      };
      this.fatal.error = error;
      return this.fatal;
    },
  };
}
