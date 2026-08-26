/**
 * Photo project 领域端口：应用层与工具只依赖此接口，不依赖具体存储实现。
 *
 * 两个实现必须保持同一套业务不变量（revision 冲突、候选选择状态机、幂等重选）：
 * - InMemoryPhotoProjectRepository（domain/photo-project-service.ts）：单测/工具测试替身。
 * - PostgresPhotoProjectRepository（infrastructure/postgres/）：生产实现。
 *
 * SQL 实现允许附加跨表完整性校验（例如 recordGeneration 校验 turn 存在），
 * 内存实现没有对应数据，不强制模拟这类外键行为。
 */

export type PhotoState = Record<string, unknown> & { constraints?: unknown[] };

export interface AssetDescriptor {
  assetId: string;
  uri?: string;
  metadata?: Record<string, unknown>;
}

export interface Asset {
  id: string;
  kind: string;
  uri: string | null;
  metadata: Record<string, unknown>;
}

export interface Candidate {
  id: string;
  assetId: string;
  verification: Record<string, unknown>;
  createdAt: string;
}

export interface GenerationCandidateInput {
  candidateId?: string;
  assetId: string;
  uri?: string;
  verification?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface GenerationOutcome {
  kind: "completed" | "failed";
  candidate?: GenerationCandidateInput;
  error?: Record<string, unknown>;
}

export interface Project {
  id: string;
  name: string;
  activeRevisionId: string;
  runningTurnId: string | null;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

export interface Revision {
  id: string;
  projectId: string;
  parentRevisionId: string | null;
  state: PhotoState;
  anchorAssetId: string | null;
  sourceGenerationId: string | null;
  createdAt: string;
}

export interface Generation {
  id: string;
  projectId: string;
  turnId: string;
  inputRevisionId: string;
  inputAssetId: string | null;
  patch: Record<string, unknown>;
  proposedState: PhotoState;
  status: "completed" | "failed";
  candidates: Candidate[];
  error: Record<string, unknown> | null;
  selectedCandidateId: string | null;
  selectedRevisionId: string | null;
  renderPrompt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  projectId?: string;
  name: string;
  initialState: PhotoState;
  anchorAsset?: AssetDescriptor | null;
  /** 多租户扩展点：调用方必须显式传入，不允许静默回落到共享默认值。 */
  ownerId: string;
}

export interface RecordGenerationInput {
  projectId: string;
  turnId: string;
  baseRevisionId: string;
  inputAssetId: string | null;
  patch: Record<string, unknown>;
  renderPrompt?: string | null;
  outcome: GenerationOutcome;
}

export interface SelectCandidateInput {
  projectId: string;
  generationId: string;
  candidateId: string;
}

export interface RecordAssetInput {
  assetId: string;
  kind?: string;
  uri?: string | null;
  metadata?: Record<string, unknown>;
}

export interface PhotoProjectRepository {
  createProject(input: CreateProjectInput): Promise<Project>;
  listProjects(ownerId: string): Promise<Project[]>;
  recordGeneration(input: RecordGenerationInput): Promise<Generation>;
  selectCandidate(input: SelectCandidateInput): Promise<Revision>;
  recordAsset(input: RecordAssetInput): Promise<Asset>;
  getProject(projectId: string): Promise<Project>;
  getGeneration(generationId: string): Promise<Generation>;
  getRevision(revisionId: string): Promise<Revision>;
  getAsset(assetId: string): Promise<Asset>;
  listRevisions(projectId: string): Promise<Revision[]>;
  listGenerations(projectId: string): Promise<Generation[]>;
  listGenerationsByTurn(input: { projectId: string; turnId: string }): Promise<Generation[]>;
}
