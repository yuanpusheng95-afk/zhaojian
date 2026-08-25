import { bigint, index, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const agentSessions = pgTable("agent_sessions", {
  id: text().primaryKey(),
  parentSessionId: text(),
  metadataJson: jsonb().notNull().default({}),
  createdAt: timestamp({ withTimezone: true }).notNull(),
}, (table) => [
  index("agent_sessions_created_idx").on(table.createdAt.desc(), table.id),
]);

export const agentSessionSequences = pgTable("agent_session_sequences", {
  sessionId: text().primaryKey().references(() => agentSessions.id, { onDelete: "cascade" }),
  nextSeq: bigint({ mode: "number" }).notNull().default(1),
});

export const agentSessionIds = pgTable("agent_session_ids", {
  sessionId: text().notNull().references(() => agentSessions.id, { onDelete: "cascade" }),
  id: text().notNull(),
  kind: text().notNull(),
}, (table) => [
  primaryKey({ columns: [table.sessionId, table.id], name: "agent_session_ids_pkey" }),
]);

export const agentSessionEntries = pgTable("agent_session_entries", {
  sessionId: text().notNull().references(() => agentSessions.id, { onDelete: "cascade" }),
  id: text().notNull(),
  seq: bigint({ mode: "number" }).notNull(),
  parentId: text(),
  type: text().notNull(),
  customType: text(),
  timestampMs: bigint({ mode: "number" }).notNull(),
  payloadJson: jsonb().notNull(),
}, (table) => [
  primaryKey({ columns: [table.sessionId, table.id], name: "agent_session_entries_pkey" }),
  uniqueIndex("agent_session_entries_session_id_seq_key").on(table.sessionId, table.seq),
  index("agent_session_entries_parent_idx").on(table.sessionId, table.parentId),
  index("agent_session_entries_type_seq_idx").on(table.sessionId, table.type, table.seq),
]);

export const agentSessionLanes = pgTable("agent_session_lanes", {
  sessionId: text().notNull().references(() => agentSessions.id, { onDelete: "cascade" }),
  lane: text().notNull(),
  leafId: text(),
}, (table) => [
  primaryKey({ columns: [table.sessionId, table.lane], name: "agent_session_lanes_pkey" }),
]);

export const agentSessionLaneMoves = pgTable("agent_session_lane_moves", {
  sessionId: text().notNull().references(() => agentSessions.id, { onDelete: "cascade" }),
  seq: bigint({ mode: "number" }).primaryKey(),
  lane: text().notNull(),
  leafId: text(),
});

export const agentSessionRecords = pgTable("agent_session_records", {
  sessionId: text().notNull().references(() => agentSessions.id, { onDelete: "cascade" }),
  id: text().notNull(),
  seq: bigint({ mode: "number" }).notNull(),
  lane: text().notNull(),
  runId: text(),
  type: text().notNull(),
  opKind: text(),
  timestampMs: bigint({ mode: "number" }).notNull(),
  payloadJson: jsonb().notNull(),
}, (table) => [
  primaryKey({ columns: [table.sessionId, table.id], name: "agent_session_records_pkey" }),
  uniqueIndex("agent_session_records_session_id_seq_key").on(table.sessionId, table.seq),
  index("agent_session_records_lane_seq_idx").on(table.sessionId, table.lane, table.seq),
  index("agent_session_records_type_seq_idx").on(table.sessionId, table.type, table.seq),
  index("agent_session_records_run_idx").on(table.sessionId, table.runId, table.seq),
]);

export const agentSessionFacts = pgTable("agent_session_facts", {
  sessionId: text().notNull().references(() => agentSessions.id, { onDelete: "cascade" }),
  seq: bigint({ mode: "number" }).notNull(),
  kind: text().notNull(),
  key: text(),
  value: text(),
}, (table) => [
  primaryKey({ columns: [table.sessionId, table.seq], name: "agent_session_facts_pkey" }),
  index("agent_session_facts_kind_key_seq_idx").on(
    table.sessionId,
    table.kind,
    table.key,
    table.seq.desc(),
  ),
]);
