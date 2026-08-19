import pg from 'pg';

import { PostgresGenerationQueue } from '../infrastructure/postgres/generation-queue.mjs';
import { runMigrations } from '../infrastructure/postgres/migrate.mjs';
import { PostgresPhotoProjectRepository } from '../infrastructure/postgres/photo-project-repository.mjs';
import { GenerationWorker } from './generation-worker.mjs';
import { MockImageProvider } from './mock-image-provider.mjs';

const { Pool } = pg;
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    'postgres://photo_agent:photo_agent@127.0.0.1:54329/photo_agent',
});
await runMigrations(pool);

const repository = new PostgresPhotoProjectRepository({ pool });
const worker = new GenerationWorker({
  queue: new PostgresGenerationQueue({ pool, repository }),
  repository,
  provider: new MockImageProvider(),
});
const pollIntervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 500);
let stopping = false;

process.once('SIGINT', () => {
  stopping = true;
});
process.once('SIGTERM', () => {
  stopping = true;
});

while (!stopping) {
  const generation = await worker.runOnce();
  if (generation) {
    process.stdout.write(
      `Generation ${generation.id} finished with ${generation.status}\n`,
    );
  } else {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

await pool.end();
