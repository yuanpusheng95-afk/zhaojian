import { pgTable, text, timestamp, jsonb, integer, bigint, index, uniqueIndex } from "drizzle-orm/pg-core";

export const assets = pgTable("assets", {
  id: text().primaryKey(),
  kind: text().notNull(),
  uri: text(),
  metadataJson: jsonb().notNull().default({}),
  createdAt: timestamp({ withTimezone: true }).notNull(),
});

export const projects = pgTable("projects", {
  id: text().primaryKey(),
  name: text().notNull(),
  activeRevisionId: text(),
  runningTurnId: text(),
  ownerId: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull(),
  updatedAt: timestamp({ withTimezone: true }).notNull(),
});

export const photoRevisions = pgTable("photo_revisions", {
  id: text().primaryKey(),
  projectId: text().notNull().references(() => projects.id),
  parentRevisionId: text(),
  stateJson: jsonb().notNull(),
  anchorAssetId: text(),
  sourceGenerationId: text(),
  createdAt: timestamp({ withTimezone: true }).notNull(),
}, (table) => [
  index("photo_revisions_project_created_idx").on(table.projectId, table.createdAt, table.id),
]);

export const agentTurns = pgTable("agent_turns", {
  id: text().primaryKey(),
  projectId: text().notNull().references(() => projects.id),
  userMessage: text().notNull(),
  idempotencyKey: text().notNull(),
  status: text().notNull(),
  leaseToken: text(),
  leaseExpiresAt: timestamp({ withTimezone: true }),
  outcomeJson: jsonb(),
  errorJson: jsonb(),
  createdAt: timestamp({ withTimezone: true }).notNull(),
  updatedAt: timestamp({ withTimezone: true }).notNull(),
}, (table) => [
  uniqueIndex("agent_turns_project_idempotency_key").on(table.projectId, table.idempotencyKey),
  index("agent_turns_queue_idx").on(table.status, table.createdAt, table.id),
  index("agent_turns_project_created_idx").on(table.projectId, table.createdAt, table.id),
]);

export const generations = pgTable("generations", {
  id: text().primaryKey(),
  projectId: text().notNull().references(() => projects.id),
  inputRevisionId: text().notNull().references(() => photoRevisions.id),
  patchJson: jsonb().notNull(),
  proposedStateJson: jsonb().notNull(),
  status: text().notNull(),
  selectedCandidateId: text(),
  selectedRevisionId: text(),
  lastErrorJson: jsonb(),
  inputAssetId: text(),
  turnId: text().notNull().references(() => agentTurns.id),
  metadataJson: jsonb().notNull().default({}),
  createdAt: timestamp({ withTimezone: true }).notNull(),
  updatedAt: timestamp({ withTimezone: true }).notNull(),
}, (table) => [
  index("generations_project_created_idx").on(table.projectId, table.createdAt, table.id),
  index("generations_turn_project_created_idx").on(table.turnId, table.projectId, table.createdAt, table.id),
]);

export const generationOutputs = pgTable("generation_outputs", {
  id: text().primaryKey(),
  generationId: text().notNull().references(() => generations.id),
  assetId: text().notNull().references(() => assets.id),
  verificationJson: jsonb().notNull().default({}),
  createdAt: timestamp({ withTimezone: true }).notNull(),
});

export const agentTelemetrySpans = pgTable("agent_telemetry_spans", {
  id: bigint({ mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  turnId: text().references(() => agentTurns.id, { onDelete: "set null" }),
  projectId: text(),
  name: text().notNull(),
  durationMs: integer().notNull(),
  status: text().notNull().default("ok"),
  attributes: jsonb().notNull().default({}),
  error: jsonb(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("agent_telemetry_spans_name_created_idx").on(table.name, table.createdAt),
  index("agent_telemetry_spans_turn_idx").on(table.turnId),
]);
