import { Session, uuidv7 } from '@earendil-works/pi-agent-core';
import { and, desc, eq } from 'drizzle-orm';
import type { Pool } from 'pg';

import { agentSessionEntries, agentSessions } from '../../../db/schema/session.js';
import { isUniqueViolation, sessionError } from './errors.js';
import { toEntry, toSessionRow } from './internal/mappers.js';
import { createPostgresSessionStorage } from './storage.js';
import {
  createSessionDatabase,
  type SessionClient,
  type SessionEntry,
  type SessionBranchQuery,
  type SessionEntryQuery,
  type SessionLanePointer,
  type SessionLogItem,
  type SessionLogOptions,
  type SessionRecord,
  type SessionRecordQuery,
  type SessionRow,
} from './types.js';
import * as queries from './internal/queries.js';
import * as mutations from './internal/mutations.js';

const DEFAULT_LANE = 'main';

export class PostgresSessionRepo {
  readonly #db;

  constructor(readonly pool: Pool) {
    if (!pool) throw new TypeError('PostgresSessionRepo requires a pg pool');
    this.#db = createSessionDatabase(pool);
  }

  async #withTransaction<T>(fn: (client: SessionClient) => Promise<T>): Promise<T> {
    try {
      return await this.#db.transaction(async (client) => fn(client as SessionClient));
    } catch (error) {
      if ((error as { name?: unknown })?.name === 'SessionError') throw error;
      if (isUniqueViolation(error)) throw sessionError('already_exists', (error as Error).message, error);
      throw sessionError('storage', (error as Error)?.message ?? String(error), error);
    }
  }

  openSession(id: string) {
    return new Session(createPostgresSessionStorage(this, id));
  }

  getSessionMetadata(sessionId: string): Promise<SessionRow | undefined> {
    return this.#withTransaction(async (client) => {
      try {
        const row = await queries.requireSession(client, sessionId);
        if (!row) throw sessionError('not_found', `Session ${sessionId} not found`);
        return row;
      } catch (error) {
        if ((error as { code?: unknown })?.code === 'not_found') return undefined;
        throw error;
      }
    });
  }

  getLanes(sessionId: string): Promise<SessionLanePointer[]> {
    return this.#withTransaction((client) => queries.readLanes(client, sessionId));
  }

  createLane(sessionId: string, lane: string, at?: string | null): Promise<void> {
    return this.#withTransaction((client) => mutations.createLane(client, sessionId, lane, at));
  }

  moveLane(sessionId: string, lane: string, to?: string | null): Promise<void> {
    return this.#withTransaction((client) => mutations.moveLane(client, sessionId, lane, to));
  }

  appendEntry(sessionId: string, entry: mutations.ProvisionedEntry, lane: string): Promise<SessionEntry> {
    return this.#withTransaction((client) => mutations.appendEntry(client, sessionId, entry, lane));
  }

  appendRecord(sessionId: string, record: mutations.NewRecord): Promise<SessionRecord> {
    return this.#withTransaction((client) => mutations.appendRecord(client, sessionId, record));
  }

  getEntry(sessionId: string, id: string): Promise<SessionEntry | undefined> {
    return this.#withTransaction(async (client) => {
      const rows = await client.select()
        .from(agentSessionEntries)
        .where(and(eq(agentSessionEntries.sessionId, sessionId), eq(agentSessionEntries.id, id)));
      return rows[0] ? toEntry(rows[0]) : undefined;
    });
  }

  findEntries(sessionId: string, query?: SessionEntryQuery): Promise<SessionEntry[]> {
    return this.#withTransaction((client) => queries.findEntries(client, sessionId, query));
  }

  findEntriesOnBranch(sessionId: string, query?: SessionBranchQuery): Promise<SessionEntry[]> {
    return this.#withTransaction((client) => queries.findEntriesOnBranch(client, sessionId, query ?? {} as SessionBranchQuery));
  }

  findRecords(sessionId: string, query?: SessionRecordQuery): Promise<SessionRecord[]> {
    return this.#withTransaction((client) => queries.findRecords(client, sessionId, query));
  }

  findOpenOperations(sessionId: string, lane: string, options?: { limit?: number }): Promise<SessionRecord[]> {
    return this.#withTransaction((client) => queries.findOpenOperations(client, sessionId, lane, options));
  }

  getLog(sessionId: string, options?: SessionLogOptions): Promise<SessionLogItem[]> {
    return this.#withTransaction((client) => queries.getLog(client, sessionId, options));
  }

  getName(sessionId: string): Promise<string | undefined> {
    return this.#withTransaction((client) => queries.getFact(client, sessionId, 'name', null));
  }

  setName(sessionId: string, name: unknown): Promise<void> {
    return this.#withTransaction((client) => mutations.setFact(client, sessionId, 'name', null, name));
  }

  getLabel(sessionId: string, id: string): Promise<string | undefined> {
    return this.#withTransaction((client) => queries.getFact(client, sessionId, 'label', id));
  }

  setLabel(sessionId: string, id: string, label: unknown): Promise<void> {
    return this.#withTransaction(async (client) => {
      await queries.validateTarget(client, sessionId, id);
      await mutations.setFact(client, sessionId, 'label', id, label);
    });
  }

  getStats(sessionId: string) {
    return this.#withTransaction((client) => queries.computeStats(client, sessionId));
  }

  async create(options: { id?: string; metadata?: Record<string, unknown> }) {
    const id = options?.id;
    if (!id) throw sessionError('invalid_payload', 'create requires an id');
    await this.#withTransaction(async (client) => {
      await mutations.insertSession(client, {
        id,
        createdAt: Date.now(),
        parentSessionId: null,
        metadata: options.metadata ?? {},
      });
      await mutations.insertLane(client, id, DEFAULT_LANE, null);
    });
    return this.openSession(id);
  }

  async open(metadata: { id: string }) {
    await this.#withTransaction(async (client) => {
      const row = await queries.requireSession(client, metadata.id);
      if (!row) throw sessionError('not_found', `Session ${metadata.id} not found`);
    });
    return this.openSession(metadata.id);
  }

  async list() {
    const rows = await this.#db.select().from(agentSessions)
      .orderBy(desc(agentSessions.createdAt), agentSessions.id);
    return rows.map(toSessionRow).map(({ id, createdAt, ...metadata }) => ({
      id, createdAt, ...metadata,
    }));
  }

  async delete(metadata: { id: string }) {
    await this.#withTransaction((client) =>
      client.delete(agentSessions).where(eq(agentSessions.id, metadata.id)),
    );
  }

  async fork(
    source: { id: string },
    options: {
      id?: string;
      parentSessionId?: string;
      metadata?: Record<string, unknown>;
      scope?: 'branch' | 'tree';
      entryId?: string;
      position?: 'before' | 'at';
    } = {},
  ) {
    const targetId = options.id ?? uuidv7();

    await this.#withTransaction(async (client) => {
      const sourceRow = await queries.requireSession(client, source.id);
      if (!sourceRow) throw sessionError('not_found', `Session ${source.id} not found`);

      let copiedEntries: SessionEntry[];
      let forkLanes: { lane: string; leafId: string | null }[];

      if (options.scope === 'tree') {
        copiedEntries = await queries.findEntries(client, source.id, { order: 'oldestFirst' });
        forkLanes = await queries.readLanes(client, source.id);
      } else {
        const mainLeaf = await queries.readLaneLeaf(client, source.id, DEFAULT_LANE);
        if (mainLeaf === undefined) {
          throw sessionError('not_found', 'Session has no main lane');
        }
        const selectedEntryId = options.entryId ?? mainLeaf;

        let branchTarget: string | null = null;
        if (selectedEntryId !== null) {
          const entry = await this.getEntry(source.id, selectedEntryId);
          if (!entry || entry.type !== 'message') {
            throw sessionError('invalid_fork_target', `Fork target is not a message entry: ${selectedEntryId}`);
          }
          const position = options.position ?? (options.entryId === undefined ? 'at' : 'before');
          branchTarget = position === 'at' ? entry.id : entry.parentId;
        }

        copiedEntries = branchTarget === null
          ? []
          : await queries.findEntriesOnBranch(client, source.id, {
              start: branchTarget,
              order: 'oldestFirst',
            });
        forkLanes = [{ lane: DEFAULT_LANE, leafId: branchTarget }];
      }

      const sourceName = await queries.getFact(client, source.id, 'name', null);

      await mutations.insertSession(client, {
        id: targetId,
        createdAt: Date.now(),
        parentSessionId: options.parentSessionId ?? source.id,
        metadata: options.metadata ?? {},
      });

      for (const entry of copiedEntries) {
        await mutations.claimId(client, targetId, entry.id, 'entry');
        const seq = await queries.nextSequence(client, targetId);
        const { type, id, parentId, timestamp, customType, ...rest } = entry;
        const payload = rest;

        await client.insert(agentSessionEntries).values({
          sessionId: targetId,
          id,
          seq,
          parentId,
          type,
          customType: type === 'custom' ? ((customType as string | undefined) ?? null) : null,
          timestampMs: timestamp,
          payloadJson: payload,
        });
      }

      for (const pointer of forkLanes) {
        await mutations.insertLane(client, targetId, pointer.lane, pointer.leafId);
        await mutations.recordLaneMove(client, targetId, pointer.lane, pointer.leafId);
      }

      if (sourceName !== undefined) {
        await mutations.setFact(client, targetId, 'name', null, sourceName);
      }

      for (const entry of copiedEntries) {
        const label = await queries.getFact(client, source.id, 'label', entry.id);
        if (label !== undefined) {
          await mutations.setFact(client, targetId, 'label', entry.id, label);
        }
      }
    });

    return this.openSession(targetId);
  }
}

export function createPostgresSessionRepo({ pool }: { pool: Pool }) {
  return new PostgresSessionRepo(pool);
}
