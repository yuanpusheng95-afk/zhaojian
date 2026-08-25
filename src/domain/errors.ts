/**
 * 错误码单一事实来源。
 *
 * 规则：
 * 1. 新增业务错误 → 在 ErrorCode 定义常量，在 ERROR_STATUS 声明 HTTP 语义。
 * 2. 错误类必须引用 ErrorCode 常量，不允许裸字符串。
 * 3. API 层的 ERROR_STATUS 从这里导入，不再自己维护字符串表。
 */

export const ErrorCode = {
  // 404
  PROJECT_NOT_FOUND: "PROJECT_NOT_FOUND",
  GENERATION_NOT_FOUND: "GENERATION_NOT_FOUND",
  TURN_NOT_FOUND: "TURN_NOT_FOUND",
  REVISION_NOT_FOUND: "REVISION_NOT_FOUND",
  ASSET_NOT_FOUND: "ASSET_NOT_FOUND",
  UNSUPPORTED_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE",

  // 409
  REVISION_CONFLICT: "REVISION_CONFLICT",
  CANDIDATE_SELECTION_ERROR: "CANDIDATE_SELECTION_ERROR",
  PROJECT_EXISTS: "PROJECT_EXISTS",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  PROJECT_BUSY: "PROJECT_BUSY",
  UNIQUE_VIOLATION: "23505",

  // 400
  INVALID_USER_ID: "INVALID_USER_ID",
  INVALID_GENERATION_REQUEST: "INVALID_GENERATION_REQUEST",
  INVALID_STATE_PATCH: "INVALID_STATE_PATCH",
  UNSAFE_STATE_PATH: "UNSAFE_STATE_PATH",
  PATCH_CONFLICT: "PATCH_CONFLICT",

  // Agent 工具层
  INVALID_ASSET_URI: "INVALID_ASSET_URI",
  ASSET_REPOSITORY_UNAVAILABLE: "ASSET_REPOSITORY_UNAVAILABLE",
  ASSET_STORAGE_UNAVAILABLE: "ASSET_STORAGE_UNAVAILABLE",

  // Worker / agent 内部
  TURN_LEASE_LOST: "TURN_LEASE_LOST",
  WORKER_LEASE_EXPIRED: "WORKER_LEASE_EXPIRED",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 业务错误码 → HTTP 状态。API 层直接使用，新增码只改这里。 */
export const ERROR_STATUS: Record<ErrorCodeValue | string, number> = {
  [ErrorCode.PROJECT_NOT_FOUND]: 404,
  [ErrorCode.GENERATION_NOT_FOUND]: 404,
  [ErrorCode.TURN_NOT_FOUND]: 404,
  [ErrorCode.REVISION_NOT_FOUND]: 404,
  [ErrorCode.ASSET_NOT_FOUND]: 404,
  [ErrorCode.UNSUPPORTED_MEDIA_TYPE]: 415,
  [ErrorCode.UNIQUE_VIOLATION]: 409,
  [ErrorCode.REVISION_CONFLICT]: 409,
  [ErrorCode.CANDIDATE_SELECTION_ERROR]: 409,
  [ErrorCode.PROJECT_EXISTS]: 409,
  [ErrorCode.IDEMPOTENCY_CONFLICT]: 409,
  [ErrorCode.PROJECT_BUSY]: 409,
  [ErrorCode.INVALID_GENERATION_REQUEST]: 400,
  [ErrorCode.INVALID_STATE_PATCH]: 400,
  [ErrorCode.UNSAFE_STATE_PATH]: 400,
  [ErrorCode.PATCH_CONFLICT]: 400,
};

/** DomainError 是所有领域层错误的基类：带类型化 code。 */
export class DomainError extends Error {
  readonly code: string;
  constructor(message: string, code: ErrorCodeValue) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 具体错误类
// ---------------------------------------------------------------------------

export class ProjectNotFoundError extends DomainError {
  readonly projectId: string;
  constructor(projectId: string) {
    super(`Project not found: ${projectId}`, ErrorCode.PROJECT_NOT_FOUND);
    this.projectId = projectId;
  }
}

export class GenerationNotFoundError extends DomainError {
  readonly generationId: string;
  constructor(generationId: string) {
    super(`Generation not found: ${generationId}`, ErrorCode.GENERATION_NOT_FOUND);
    this.generationId = generationId;
  }
}

export class RevisionConflictError extends DomainError {
  readonly projectId: string;
  readonly expectedRevisionId: string;
  readonly actualRevisionId: string | null;
  constructor({ projectId, expectedRevisionId, actualRevisionId }: {
    projectId: string; expectedRevisionId: string; actualRevisionId: string | null;
  }) {
    super(
      `Revision conflict for project ${projectId}: expected ${expectedRevisionId}, active ${actualRevisionId}`,
      ErrorCode.REVISION_CONFLICT,
    );
    this.projectId = projectId;
    this.expectedRevisionId = expectedRevisionId;
    this.actualRevisionId = actualRevisionId;
  }
}

export class RevisionNotFoundError extends DomainError {
  readonly revisionId: string;
  constructor(revisionId: string) {
    super(`Revision not found: ${revisionId}`, ErrorCode.REVISION_NOT_FOUND);
    this.revisionId = revisionId;
  }
}

export class InvalidGenerationRequestError extends DomainError {
  constructor(message: string) {
    super(message, ErrorCode.INVALID_GENERATION_REQUEST);
  }
}

export class CandidateSelectionError extends DomainError {
  constructor(message: string) {
    super(message, ErrorCode.CANDIDATE_SELECTION_ERROR);
  }
}

export class TurnNotFoundError extends DomainError {
  readonly projectId: string;
  readonly turnId: string;
  constructor(projectId: string, turnId: string) {
    super(`Turn not found for project ${projectId}: ${turnId}`, ErrorCode.TURN_NOT_FOUND);
    this.projectId = projectId;
    this.turnId = turnId;
  }
}

export class AssetNotFoundError extends DomainError {
  readonly assetId: string;
  constructor(assetId: string) {
    super(`Asset not found: ${assetId}`, ErrorCode.ASSET_NOT_FOUND);
    this.assetId = assetId;
  }
}
