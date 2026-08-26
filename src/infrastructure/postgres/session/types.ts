import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

import * as schema from "@/db/schema/session";
import type {
  BranchBounds,
  Entry,
  EntryOrder,
  LaneRecord,
} from "@earendil-works/pi-agent-core";

type DrizzleDatabase = NodePgDatabase<typeof schema>;

export type SessionTransaction = Parameters<Parameters<DrizzleDatabase["transaction"]>[0]>[0];

export type SessionClient = DrizzleDatabase | SessionTransaction;

export type { DrizzleDatabase };

export function createSessionDatabase(pool: Pool): DrizzleDatabase {
  return drizzle(pool, { schema, casing: "snake_case" });
}

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

type SessionRowBase = {
  sessionId: string;
  seq: number;
  id: string;
  type: string;
  timestampMs: number;
  payloadJson: Record<string, unknown> | null;
};

export type SessionEntryRow = SessionRowBase & {
  parentId: string | null;
  customType: string | null;
};

export type SessionRecordRow = SessionRowBase & {
  lane: string;
  runId: string | null;
  opKind: string | null;
};

export type SessionEntry = Record<string, unknown> & {
  type: string;
  id: string;
  seq: number;
  parentId: string | null;
  timestamp: number;
};

export type ProvisionedSessionEntry = Omit<Entry, "parentId" | "seq" | "timestamp">;

export type NewSessionRecord = Omit<LaneRecord, "seq" | "timestamp">;

export type SessionRecord = Record<string, unknown> & {
  type: string;
  id: string;
  seq: number;
  lane: string;
  timestamp: number;
};

export type SessionLanePointer = {
  lane: string;
  leafId: string | null;
};

export type SessionEntryQuery = {
  order?: EntryOrder;
  limit?: number;
  type?: Entry["type"];
  customType?: string;
  cursor?: { afterSeq?: number };
};

export type SessionBranchQuery = SessionEntryQuery & BranchBounds;

export type SessionRecordQuery = {
  lane?: string;
  type?: LaneRecord["type"];
  runId?: string;
  operationKind?: "run" | "compaction" | "navigation";
  afterSeq?: number;
  order?: EntryOrder;
  limit?: number;
};

export type SessionLogItem =
  | { kind: "entry"; seq: number; entry: SessionEntry }
  | { kind: "record"; seq: number; record: SessionRecord }
  | { kind: "fact"; seq: number; fact: "name"; name?: string }
  | { kind: "fact"; seq: number; fact: "label"; targetId?: string; label?: string }
  | { kind: "lane"; seq: number; lane: string; leafId: string | null };

export type SessionLogOptions = {
  afterSeq?: number;
  limit?: number;
};

export function isSessionError(error: unknown): error is SessionErrorLike & { code: string } {
  return Boolean(error) && typeof error === "object" && "code" in (error as object);
}
