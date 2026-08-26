import { and, asc, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';

import {
  agentSessionEntries,
  agentSessionFacts,
  agentSessionLaneMoves,
  agentSessionLanes,
  agentSessionRecords,
  agentSessionSequences,
  agentSessions,
} from '@/db/schema/session.js';
import {
  assertValidCursor,
  assertValidLimit,
  matchesEntryQuery,
  queryRows,
  toEntry,
  toLanePointer,
  toRecord,
} from '@/infrastructure/postgres/session/internal/mappers.js';
import { sessionError } from '@/infrastructure/postgres/session/errors.js';
import type {
  SessionClient,
  SessionEntry,
  SessionBranchQuery,
  SessionEntryQuery,
  SessionLanePointer,
  SessionLogItem,
  SessionLogOptions,
  SessionRecord,
  SessionRecordQuery,
  SessionRow,
} from '@/infrastructure/postgres/session/types.js';

export async function requireSession(client: SessionClient, id: string): Promise<SessionRow | undefined> {
  const rows = await client.select().from(agentSessions).where(eq(agentSessions.id, id));
  return rows[0] ? {
    id: rows[0].id,
    createdAt: rows[0].createdAt.getTime(),
    parentSessionId: rows[0].parentSessionId,
    metadata: (rows[0].metadataJson ?? {}) as Record<string, unknown>,
  } : undefined;
}

export async function nextSequence(client: SessionClient, sessionId: string): Promise<number> {
  const rows = await queryRows(client, sql`
    update ${agentSessionSequences}
       set next_seq = next_seq + 1
     where session_id = ${sessionId}
     returning next_seq - 1 as seq
  `);
  if (!rows.length) throw new Error(`No sequence row for session ${sessionId}`);
  return Number(rows[0]!.seq);
}

export async function readLanes(client: SessionClient, sessionId: string): Promise<SessionLanePointer[]> {
  const rows = await client.select({ lane: agentSessionLanes.lane, leafId: agentSessionLanes.leafId })
    .from(agentSessionLanes)
    .where(eq(agentSessionLanes.sessionId, sessionId))
    .orderBy(asc(agentSessionLanes.lane));
  return rows.map(toLanePointer);
}

export async function readLaneLeaf(
  client: SessionClient,
  sessionId: string,
  lane: string,
): Promise<string | null | undefined> {
  const rows = await client.select({ leafId: agentSessionLanes.leafId })
    .from(agentSessionLanes)
    .where(and(eq(agentSessionLanes.sessionId, sessionId), eq(agentSessionLanes.lane, lane)));
  return rows[0]?.leafId;
}

export async function requireLane(client: SessionClient, sessionId: string, lane: string) {
  const leafId = await readLaneLeaf(client, sessionId, lane);
  if (leafId === undefined) throw sessionError('invalid_lane', `Lane not found: ${lane}`);
  return leafId;
}

export async function validateTarget(client: SessionClient, sessionId: string, targetId?: string | null) {
  if (targetId === null || targetId === undefined) return;
  const rows = await client.select({ id: agentSessionEntries.id })
    .from(agentSessionEntries)
    .where(and(eq(agentSessionEntries.sessionId, sessionId), eq(agentSessionEntries.id, targetId)));
  if (!rows.length) throw sessionError('not_found', `Entry not found: ${targetId}`);
}

export async function getFact(client: SessionClient, sessionId: string, kind: string, key: string | null) {
  const rows = await client.select({ value: agentSessionFacts.value })
    .from(agentSessionFacts)
    .where(and(
      eq(agentSessionFacts.sessionId, sessionId),
      eq(agentSessionFacts.kind, kind),
      key === null ? isNull(agentSessionFacts.key) : eq(agentSessionFacts.key, key),
    ))
    .orderBy(desc(agentSessionFacts.seq))
    .limit(1);
  return rows[0]?.value ?? undefined;
}

export async function findEntries(
  client: SessionClient,
  sessionId: string,
  query: SessionEntryQuery = {},
): Promise<SessionEntry[]> {
  assertValidLimit(query.limit);
  assertValidCursor(query.cursor?.afterSeq);
  const rows = await client.select().from(agentSessionEntries)
    .where(eq(agentSessionEntries.sessionId, sessionId))
    .orderBy(query.order === 'oldestFirst' ? agentSessionEntries.seq : desc(agentSessionEntries.seq));

  const results: SessionEntry[] = [];
  for (const row of rows) {
    const entry = toEntry(row);
    if (!matchesEntryQuery(entry, query)) continue;
    results.push(entry);
    if (results.length === query.limit) break;
  }
  return results;
}

export async function findEntriesOnBranch(
  client: SessionClient,
  sessionId: string,
  query: SessionBranchQuery,
): Promise<SessionEntry[]> {
  assertValidLimit(query.limit);
  assertValidCursor(query.cursor?.afterSeq);
  if (!query.start) throw sessionError('invalid_query', 'findEntriesOnBranch requires a start');

  const rows = await queryRows(client, sql`
    with recursive branch as (
      select id, seq, parent_id, type, custom_type, timestamp_ms, payload_json
        from ${agentSessionEntries}
       where session_id = ${sessionId} and id = ${query.start}
       union all
      select e.id, e.seq, e.parent_id, e.type, e.custom_type, e.timestamp_ms, e.payload_json
        from ${agentSessionEntries} e
        join branch on e.id = branch.parent_id
       where e.session_id = ${sessionId}
    )
    select * from branch order by seq desc
  `);
  if (!rows.length) throw sessionError('not_found', `Entry not found: ${query.start}`);

  const leafToRoot = rows.map(toEntry);
  const results: SessionEntry[] = [];
  if (query.order === 'oldestFirst') {
    for (const entry of [...leafToRoot].reverse()) {
      const reachedBound = entry.id === query.stopAtId || entry.type === query.stopAtType;
      if (matchesEntryQuery(entry, query)) results.push(entry);
      if (reachedBound || results.length === query.limit) break;
    }
  } else {
    for (const entry of leafToRoot) {
      if (matchesEntryQuery(entry, query)) results.push(entry);
      if (results.length === query.limit) break;
      if (entry.id === query.stopAtId || entry.type === query.stopAtType) break;
    }
  }
  return results;
}

function validateRecordQuery(query: SessionRecordQuery) {
  assertValidLimit(query.limit);
  assertValidCursor(query.afterSeq);
}

export async function findRecords(
  client: SessionClient,
  sessionId: string,
  query: SessionRecordQuery = {},
): Promise<SessionRecord[]> {
  validateRecordQuery(query);

  let statement = sql`
    select id, seq, lane, run_id, type, op_kind, timestamp_ms, payload_json
      from ${agentSessionRecords}
     where session_id = ${sessionId}
  `;
  if (query.type !== undefined) statement = sql`${statement} and type = ${query.type}`;
  if (query.lane !== undefined) statement = sql`${statement} and lane = ${query.lane}`;
  if (query.runId !== undefined) {
    statement = sql`${statement} and (
      (type = 'operation_started' and id = ${query.runId}) or
      (type <> 'operation_started' and run_id = ${query.runId})
    )`;
  }
  if (query.operationKind !== undefined) {
    statement = sql`${statement} and type = 'operation_started' and op_kind = ${query.operationKind}`;
  }
  if (query.afterSeq !== undefined) statement = sql`${statement} and seq > ${query.afterSeq}`;
  statement = sql`${statement} order by seq ${query.order === 'oldestFirst' ? sql`asc` : sql`desc`}`;
  if (query.limit !== undefined) statement = sql`${statement} limit ${query.limit}`;

  return (await queryRows(client, statement)).map(toRecord);
}

export async function findOpenOperations(
  client: SessionClient,
  sessionId: string,
  lane: string,
  options: { limit?: number } = {},
): Promise<SessionRecord[]> {
  let statement = sql`
    select started.*
      from ${agentSessionRecords} started
     where started.session_id = ${sessionId}
       and started.lane = ${lane}
       and started.type = 'operation_started'
       and not exists (
         select 1
           from ${agentSessionRecords} finished
          where finished.session_id = started.session_id
            and finished.type = 'operation_finished'
            and finished.run_id = started.id
            and finished.seq > started.seq
       )
     order by started.seq desc
  `;
  if (options.limit !== undefined) statement = sql`${statement} limit ${options.limit}`;

  return (await queryRows(client, statement)).map(toRecord);
}

export async function computeStats(client: SessionClient, sessionId: string) {
  const [messages] = await queryRows(client, sql`
    select count(*) as message_count
      from ${agentSessionEntries}
     where session_id = ${sessionId} and type = 'message'
  `);
  const [usage] = await queryRows(client, sql`
    select
      coalesce(sum((payload_json -> 'usage' ->> 'cacheRead')::numeric), 0) as cached_tokens,
      coalesce(sum((payload_json -> 'usage' ->> 'input')::numeric), 0)
        + coalesce(sum((payload_json -> 'usage' ->> 'cacheWrite')::numeric), 0) as uncached_tokens,
      coalesce(sum((payload_json -> 'usage' ->> 'totalTokens')::numeric), 0) as total_tokens,
      coalesce(sum((payload_json -> 'usage' -> 'cost' ->> 'total')::numeric), 0) as cost_total
      from ${agentSessionRecords}
     where session_id = ${sessionId} and type = 'usage'
  `);

  return {
    messageCount: Number(messages?.message_count ?? 0),
    cachedTokens: Number(usage?.cached_tokens ?? 0),
    uncachedTokens: Number(usage?.uncached_tokens ?? 0),
    totalTokens: Number(usage?.total_tokens ?? 0),
    costTotal: Number(usage?.cost_total ?? 0),
  };
}

export async function getLog(
  client: SessionClient,
  sessionId: string,
  options: SessionLogOptions = {},
): Promise<SessionLogItem[]> {
  assertValidCursor(options.afterSeq);
  assertValidLimit(options.limit);

  const cursorSql: SQL = options.afterSeq === undefined
    ? sql`where source.session_id = ${sessionId}`
    : sql`where source.session_id = ${sessionId} and source.seq > ${options.afterSeq}`;
  const limitSql: SQL = options.limit === undefined ? sql`` : sql` limit ${options.limit}`;

  const rows = await queryRows(client, sql`
    select *
      from (
        select session_id, seq, 'entry' as kind,
               jsonb_build_object(
                 'payloadJson', payload_json,
                 'id', id,
                 'seq', seq,
                 'parentId', parent_id,
                 'type', type,
                 'timestampMs', timestamp_ms
               ) as item
          from ${agentSessionEntries}
        union all
        select session_id, seq, 'record' as kind,
               jsonb_build_object(
                 'payloadJson', payload_json,
                 'id', id,
                 'seq', seq,
                 'lane', lane,
                 'runId', run_id,
                 'type', type,
                 'opKind', op_kind,
                 'timestampMs', timestamp_ms
               ) as item
          from ${agentSessionRecords}
        union all
        select session_id, seq, 'fact' as kind,
               jsonb_build_object('kind', kind, 'key', key, 'value', value) as item
          from ${agentSessionFacts}
        union all
        select session_id, seq, 'lane' as kind,
               jsonb_build_object('lane', lane, 'leafId', leaf_id) as item
          from ${agentSessionLaneMoves}
      ) as source
      ${cursorSql}
     order by seq asc
     ${limitSql}
  `);

  return rows.map((row): SessionLogItem => {
    const item = row.item as Record<string, unknown>;
    const seq = Number(row.seq);
    switch (row.kind) {
      case 'entry': return { kind: 'entry', seq, entry: toEntry(item) };
      case 'record': return { kind: 'record', seq, record: toRecord(item) };
      case 'fact':
        return item.kind === 'name'
          ? { kind: 'fact', seq, fact: 'name', name: item.value === null || item.value === undefined ? undefined : String(item.value) }
          : {
              kind: 'fact',
              seq,
              fact: 'label',
              targetId: item.key == null ? undefined : String(item.key),
              label: item.value === null || item.value === undefined ? undefined : String(item.value),
            };
      case 'lane':
        return {
          kind: 'lane',
          seq,
          lane: String(item.lane),
          leafId: item.leafId == null ? null : String(item.leafId),
        };
      default: throw new Error(`Unknown log item kind: ${row.kind}`);
    }
  });
}

export type { SessionBranchQuery, SessionEntryQuery, SessionRecordQuery };
