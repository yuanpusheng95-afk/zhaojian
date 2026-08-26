import type { SessionMetadata, SessionStorage as CoreSessionStorage } from '@earendil-works/pi-agent-core';
import type { PostgresSessionRepo } from '@/infrastructure/postgres/session/repo.js';
import type {
  NewSessionRecord,
  ProvisionedSessionEntry,
  SessionBranchQuery,
  SessionEntryQuery,
  SessionRecordQuery,
} from '@/infrastructure/postgres/session/types.js';
import { isUniqueViolation, sessionError } from '@/infrastructure/postgres/session/errors.js';

function translate(error: unknown) {
  if ((error as { name?: unknown })?.name === 'SessionError') return error;
  if (isUniqueViolation(error)) return sessionError('already_exists', (error as Error).message, error);
  if (error instanceof TypeError) return sessionError('invalid_payload', error.message, error);
  return sessionError('storage', (error as Error)?.message ?? String(error), error);
}

export function createPostgresSessionStorage(
  repo: PostgresSessionRepo,
  sessionId: string,
): CoreSessionStorage<SessionMetadata> {
  if (!repo) throw new TypeError('createPostgresSessionStorage requires a session repository');
  if (!sessionId) throw new TypeError('createPostgresSessionStorage requires a sessionId');

  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      throw translate(error);
    }
  };

  const storage = {
    getMetadata: () =>
      run(async () => {
        const metadata = await repo.getSessionMetadata(sessionId);
        if (!metadata) throw sessionError('not_found', `Session ${sessionId} not found`);
        return {
          id: metadata.id,
          createdAt: metadata.createdAt,
          parentSessionId: metadata.parentSessionId ?? undefined,
          ...metadata.metadata,
        };
      }),
    getLanes: () => run(() => repo.getLanes(sessionId)),
    createLane: (lane: string, at?: string | null) => run(() => repo.createLane(sessionId, lane, at)),
    moveLane: (lane: string, to?: string | null) => run(() => repo.moveLane(sessionId, lane, to)),
    appendEntry: (entry: ProvisionedSessionEntry, lane: string) => run(() => repo.appendEntry(sessionId, entry, lane)),
    appendRecord: (record: NewSessionRecord) => run(() => repo.appendRecord(sessionId, record)),
    getEntry: (id: string) => run(() => repo.getEntry(sessionId, id)),
    findEntries: (query?: SessionEntryQuery) => run(() => repo.findEntries(sessionId, query)),
    findEntriesOnBranch: (query?: SessionBranchQuery) => run(() => repo.findEntriesOnBranch(sessionId, query)),
    findRecords: (query?: SessionRecordQuery) => run(() => repo.findRecords(sessionId, query)),
    findOpenOperations: (
      lane: string,
      options?: { limit?: number },
    ) => run(() => repo.findOpenOperations(sessionId, lane, options)),
    getLog: (options?: { afterSeq?: number; limit?: number }) => run(() => repo.getLog(sessionId, options)),
    getName: () => run(() => repo.getName(sessionId)),
    setName: (name: unknown) => run(() => repo.setName(sessionId, name)),
    getLabel: (id: string) => run(() => repo.getLabel(sessionId, id)),
    setLabel: (id: string, label: unknown) => run(() => repo.setLabel(sessionId, id, label)),
    getStats: () => run(() => repo.getStats(sessionId)),
  };

  return storage as unknown as CoreSessionStorage<SessionMetadata>;
}
