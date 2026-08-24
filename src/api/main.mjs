import pg from 'pg';

import { createAgentTurnQueue } from '../infrastructure/postgres/agent-turn-queue.mjs';
import { createS3AssetStorage } from '../infrastructure/storage/s3-asset-storage.mjs';
import { loadApiConfig } from '../config.mjs';
import { createTurnViews } from './turn-views.mjs';
import { PostgresPhotoProjectRepository } from '../infrastructure/postgres/photo-project-repository.mjs';
import { createApiServer } from './server.mjs';

const config = loadApiConfig(process.env);
const { Pool } = pg;
const pool = new Pool({
  connectionString: config.databaseUrl,
});

const repository = new PostgresPhotoProjectRepository({ pool });
const queue = createAgentTurnQueue({ pool });
const assetStorage = createS3AssetStorage(config.s3);
const turnViews = createTurnViews({
  pool,
  repository,
  assetStorage,
  signedUrlTtlSeconds: config.signedUrlTtlSeconds,
});
const server = createApiServer({ repository, queue, turnViews, assetStorage, corsOrigin: config.corsOrigin });
const port = config.port;
server.listen(port, () => {
  process.stdout.write(`Photo Agent API listening on :${port}\n`);
});

async function shutdown() {
  server.closeIdleConnections();
  server.closeActiveEventStreams();
  await new Promise((resolve) => server.close(resolve));
  server.closeAllConnections();
  await pool.end();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
