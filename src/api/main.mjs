import pg from 'pg';

import { runMigrations } from '../infrastructure/postgres/migrate.mjs';
import { PostgresPhotoProjectRepository } from '../infrastructure/postgres/photo-project-repository.mjs';
import { createApiServer } from './server.mjs';

const { Pool } = pg;
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    'postgres://photo_agent:photo_agent@127.0.0.1:54329/photo_agent',
});
await runMigrations(pool);

const repository = new PostgresPhotoProjectRepository({ pool });
const server = createApiServer({ repository });
const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => {
  process.stdout.write(`Photo Agent API listening on :${port}\n`);
});

async function shutdown() {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
