import { sql, type SQL } from 'drizzle-orm';

import type {
  SessionClient,
  SessionEntry,
  SessionEntryRow,
  SessionEntryQuery,
  SessionLanePointer,
  SessionRecord,
  SessionRecordRow,
} from '../types.js';
import { sessionError } from '../errors.js';

export async function queryRows(client: SessionClient, statement: SQL): Promise<Record<string, unknown>[]> {
  const result = await client.execute(statement);
  return (result as unknown as { rows?: Record<string, unknown>[] }).rows ?? [];
}

export function toSessionRow(row: {
  id: string; createdAt: Date; parentSessionId: string | null;
  metadataJson?: unknown;
}) {
  return {
    id: row.id,
    createdAt: row.createdAt.getTime(),
    parentSessionId: row.parentSessionId ?? undefined,
    metadata: row.metadataJson ?? {},
  };
}

export function toEntry(input: SessionEntryRow | Record<string, unknown>): SessionEntry {
  const row = normalizeRow(input);
  const payload = row.payloadJson ?? {};
  return {
    ...(payload as Record<string, unknown>),
    type: String(row.type),
    id: String(row.id),
    seq: Number(row.seq),
    parentId: row.parentId == null ? null : String(row.parentId),
    timestamp: Number(row.timestampMs),
  };
}

export function toRecord(input: SessionRecordRow | Record<string, unknown>): SessionRecord {
  const row = normalizeRow(input);
  const payload = row.payloadJson ?? {};
  return {
    ...(payload as Record<string, unknown>),
    type: String(row.type),
    id: String(row.id),
    seq: Number(row.seq),
    lane: String(row.lane),
    timestamp: Number(row.timestampMs),
  };
}

export function toLanePointer(row: { lane: string; leafId?: string | null }): SessionLanePointer {
  return { lane: row.lane, leafId: row.leafId ?? null };
}

function normalizeRow(row: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key.replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase()),
    value,
  ]));
}

export function assertJsonSerializable(value: unknown, what: string): Record<string, unknown> {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (cause) {
    throw new TypeError(`${what} is not JSON-serializable`, { cause });
  }
  if (serialized === undefined) throw new TypeError(`${what} is not JSON-serializable`);
  return JSON.parse(serialized);
}

export function assertValidLimit(limit?: number) {
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw sessionError('invalid_query', 'limit must be a positive integer');
  }
}

export function assertValidCursor(afterSeq?: number) {
  if (afterSeq !== undefined && (!Number.isInteger(afterSeq) || afterSeq < 0)) {
    throw sessionError('invalid_query', 'cursor sequence must be a non-negative integer');
  }
}

export function matchesEntryQuery(entry: SessionEntry, query: SessionEntryQuery) {
  if (query.type !== undefined && entry.type !== query.type) return false;
  if (query.customType !== undefined && !(entry.type === 'custom' && entry.customType === query.customType)) return false;
  if (query.cursor !== undefined) {
    const afterSeq = query.cursor.afterSeq ?? Number.NEGATIVE_INFINITY;
    return query.order === 'oldestFirst' ? entry.seq > afterSeq : entry.seq < afterSeq;
  }
  return true;
}
