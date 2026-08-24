import type { Pool, PoolClient } from "pg";

export type SessionDatabase = Pool | PoolClient;

export type SessionErrorCode =
  | "already_exists"
  | "invalid_fork_target"
  | "invalid_lane"
  | "invalid_payload"
  | "invalid_query"
  | "not_found"
  | "storage";

export type SessionErrorLike = Error & { code?: string; name?: string };

export type SessionRow = {
  id: string;
  createdAt: number;
  parentSessionId: string | null;
  metadata: Record<string, unknown>;
};

export type SessionEntryRow = {
  id: string;
  seq: number | string;
  parent_id: string | null;
  type: string;
  custom_type: string | null;
  timestamp_ms: number | string;
  payload_json: Record<string, unknown> & { customType?: string };
};

export type SessionRecordRow = {
  id: string;
  seq: number | string;
  parent_id?: string | null;
  lane: string;
  type: string;
  timestamp_ms: number | string;
  payload_json: Record<string, unknown>;
};

export type SessionEntryQuery = {
  order?: "oldestFirst" | "newestFirst";
  limit?: number;
  type?: string;
  customType?: string;
  cursor?: { afterSeq?: number };
  start?: string;
  stopAtId?: string;
  stopAtType?: string;
};

export type SessionRecordQuery = SessionEntryQuery & {
  lane?: string;
  runId?: string;
};

export function isSessionError(error: unknown): error is SessionErrorLike & { code: string } {
  return Boolean(error) && typeof error === "object" && "code" in (error as object);
}
