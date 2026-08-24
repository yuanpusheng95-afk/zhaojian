import { pgTable, text, timestamp, jsonb, integer, bigint, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const assets = pgTable("assets", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  uri: text("uri"),
  metadataJson: jsonb("metadata_json").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  activeRevisionId: text("active_revision_id"),
  runningTurnId: text("running_turn_id"),
  ownerId: text("owner_id").notNull().default("dev"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const photoRevisions = pgTable("photo_revisions", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  parentRevisionId: text("parent_revision_id"),
  stateJson: jsonb("state_json").notNull(),
  anchorAssetId: text("anchor_asset_id"),
  sourceGenerationId: text("source_generation_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (table) => [
  index("photo_revisions_project_created_idx").on(table.projectId, table.createdAt, table.id),
]);

export const agentTurns = pgTable("agent_turns", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  userMessage: text("user_message").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  status: text("status").notNull(),
  leaseToken: text("lease_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  outcomeJson: jsonb("outcome_json"),
  errorJson: jsonb("error_json"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (table) => [
  uniqueIndex("agent_turns_project_idempotency_key").on(table.projectId, table.idempotencyKey),
  index("agent_turns_queue_idx").on(table.status, table.createdAt, table.id),
  index("agent_turns_project_created_idx").on(table.projectId, table.createdAt, table.id),
]);

export const generations = pgTable("generations", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  inputRevisionId: text("input_revision_id").notNull().references(() => photoRevisions.id),
  patchJson: jsonb("patch_json").notNull(),
  proposedStateJson: jsonb("proposed_state_json").notNull(),
  status: text("status").notNull(),
  selectedCandidateId: text("selected_candidate_id"),
  selectedRevisionId: text("selected_revision_id"),
  lastErrorJson: jsonb("last_error_json"),
  inputAssetId: text("input_asset_id"),
  turnId: text("turn_id").notNull().references(() => agentTurns.id),
  metadataJson: jsonb("metadata_json").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (table) => [
  index("generations_project_created_idx").on(table.projectId, table.createdAt, table.id),
  index("generations_turn_project_created_idx").on(table.turnId, table.projectId, table.createdAt, table.id),
]);

export const generationOutputs = pgTable("generation_outputs", {
  id: text("id").primaryKey(),
  generationId: text("generation_id").notNull().references(() => generations.id),
  assetId: text("asset_id").notNull().references(() => assets.id),
  verificationJson: jsonb("verification_json").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const agentSessions = pgTable("agent_sessions", {
  id: text("id").primaryKey(),
  parentSessionId: text("parent_session_id"),
  metadataJson: jsonb("metadata_json").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const agentEntries = pgTable("agent_entries", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => agentSessions.id, { onDelete: "cascade" }),
  seq: bigint("seq", { mode: "number" }).notNull(),
  parentId: text("parent_id"),
  laneId: text("lane_id"),
  type: text("type").notNull(),
  dataJson: jsonb("data_json"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const agentLanes = pgTable("agent_lanes", {
  sessionId: text("session_id").notNull().references(() => agentSessions.id, { onDelete: "cascade" }),
  id: text("id").notNull(),
  leafEntryId: text("leaf_entry_id"),
  name: text("name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (table) => [
  uniqueIndex("agent_lanes_session_id_idx").on(table.sessionId, table.id),
]);

export const agentRecords = pgTable("agent_records", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => agentSessions.id, { onDelete: "cascade" }),
  seq: bigint("seq", { mode: "number" }).notNull(),
  type: text("type").notNull(),
  dataJson: jsonb("data_json"),
  laneId: text("lane_id"),
  operationId: text("operation_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const agentSequences = pgTable("agent_sequences", {
  sessionId: text("session_id").notNull().references(() => agentSessions.id, { onDelete: "cascade" }),
  value: bigint("value", { mode: "number" }).notNull(),
}, (table) => [
  uniqueIndex("agent_sequences_session_id_idx").on(table.sessionId),
]);

export const agentTelemetrySpans = pgTable("agent_telemetry_spans", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  turnId: text("turn_id").references(() => agentTurns.id, { onDelete: "set null" }),
  projectId: text("project_id"),
  name: text("name").notNull(),
  durationMs: integer("duration_ms").notNull(),
  status: text("status").notNull().default("ok"),
  attributes: jsonb("attributes").notNull().default({}),
  error: jsonb("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("agent_telemetry_spans_name_created_idx").on(table.name, table.createdAt),
  index("agent_telemetry_spans_turn_idx").on(table.turnId),
]);
