import { and, eq } from 'drizzle-orm';

import {
  agentSessionEntries,
  agentSessionFacts,
  agentSessionIds,
  agentSessionLaneMoves,
  agentSessionLanes,
  agentSessionRecords,
  agentSessions,
  agentSessionSequences,
} from '../../../../db/schema/session.js';
import { assertJsonSerializable } from './mappers.js';
import { sessionError } from '../errors.js';
import type { LaneRecord } from '@earendil-works/pi-agent-core';
import type { SessionClient } from '../types.js';
import type { NewSessionRecord, ProvisionedSessionEntry, SessionEntry, SessionRecord } from '../types.js';
import {
  findOpenOperations,
  nextSequence,
  readLaneLeaf,
  requireLane,
  validateTarget,
} from './queries.js';

export type ProvisionedEntry = ProvisionedSessionEntry;

export type NewRecord = NewSessionRecord;

export async function insertSession(client: SessionClient, input: {
  id: string; createdAt: number; parentSessionId?: string | null; metadata?: Record<string, unknown>;
}) {
  await client.insert(agentSessions).values({
    id: input.id,
    createdAt: new Date(input.createdAt),
    parentSessionId: input.parentSessionId ?? null,
    metadataJson: input.metadata ?? {},
  });
  await client.insert(agentSessionSequences).values({ sessionId: input.id });
}

export async function claimId(client: SessionClient, sessionId: string, id: string, kind: 'entry' | 'record') {
  await client.insert(agentSessionIds).values({ sessionId, id, kind });
}

export async function insertLane(client: SessionClient, sessionId: string, lane: string, leafId: string | null) {
  await client.insert(agentSessionLanes).values({ sessionId, lane, leafId });
}

export async function recordLaneMove(client: SessionClient, sessionId: string, lane: string, leafId: string | null) {
  const seq = await nextSequence(client, sessionId);
  await client.insert(agentSessionLaneMoves).values({ sessionId, seq, lane, leafId });
}

export async function setFact(client: SessionClient, sessionId: string, kind: string, key: string | null, value: unknown) {
  const seq = await nextSequence(client, sessionId);
  await client.insert(agentSessionFacts).values({
    sessionId,
    seq,
    kind,
    key,
    value: value == null ? null : String(value),
  });
}

export async function createLane(client: SessionClient, sessionId: string, lane: string, at?: string | null) {
  if (await readLaneLeaf(client, sessionId, lane) !== undefined) {
    throw sessionError('already_exists', `Lane already exists: ${lane}`);
  }
  await validateTarget(client, sessionId, at);
  const target = at ?? null;
  await insertLane(client, sessionId, lane, target);
  await recordLaneMove(client, sessionId, lane, target);
}

export async function moveLane(client: SessionClient, sessionId: string, lane: string, to?: string | null) {
  await requireLane(client, sessionId, lane);
  await validateTarget(client, sessionId, to);
  const target = to ?? null;
  await client.update(agentSessionLanes)
    .set({ leafId: target })
    .where(and(eq(agentSessionLanes.sessionId, sessionId), eq(agentSessionLanes.lane, lane)));
  await recordLaneMove(client, sessionId, lane, target);
}

export async function appendEntry(
  client: SessionClient,
  sessionId: string,
  provisioned: ProvisionedEntry,
  lane: string,
): Promise<SessionEntry> {
  const { type, id, ...destructuredRest } = provisioned;
  const rest: Record<string, unknown> = destructuredRest;
  const payload = assertJsonSerializable(rest, `entry ${id}`);
  const leafId = await requireLane(client, sessionId, lane);
  await claimId(client, sessionId, id, 'entry');
  const seq = await nextSequence(client, sessionId);
  const timestamp = Date.now();

  const row: typeof agentSessionEntries.$inferInsert = {
    sessionId,
    id,
    seq,
    parentId: leafId,
    type,
    customType: type === 'custom'
      ? typeof rest.customType === 'string' ? rest.customType : null
      : null,
    timestampMs: timestamp,
    payloadJson: payload,
  };
  await client.insert(agentSessionEntries).values(row);
  await client.update(agentSessionLanes)
    .set({ leafId: id })
    .where(and(eq(agentSessionLanes.sessionId, sessionId), eq(agentSessionLanes.lane, lane)));

  return { ...payload, type, id, seq, parentId: leafId, timestamp };
}

export async function appendRecord(
  client: SessionClient,
  sessionId: string,
  newRecord: NewRecord,
): Promise<SessionRecord> {
  const record = newRecord as LaneRecord & { id: string; lane: string };
  const { type, id, lane, seq: _seq, timestamp: _timestamp, ...destructuredRest } = record;
  const rest: Record<string, unknown> = destructuredRest;
  const payload = assertJsonSerializable(rest, `record ${id}`);
  await requireLane(client, sessionId, lane);

  if (type === 'operation_started') {
    const open = await findOpenOperations(client, sessionId, lane, { limit: 1 });
    if (open.length > 0) {
      throw sessionError('storage', `Lane ${lane} already has an open operation: ${open[0].id}`);
    }
  }

  await claimId(client, sessionId, id, 'record');
  const seq = await nextSequence(client, sessionId);
  const timestamp = Date.now();

  await client.insert(agentSessionRecords).values({
    sessionId,
    id,
    seq,
    lane,
    runId: "runId" in rest ? ((rest.runId as string | undefined) ?? null) : null,
    type,
    opKind: record.type === "operation_started" ? record.intent.kind : null,
    timestampMs: timestamp,
    payloadJson: payload,
  });

  return { ...payload, type, id, seq, lane, timestamp };
}
