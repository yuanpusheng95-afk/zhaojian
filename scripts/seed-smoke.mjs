import pg from 'pg';
import { loadWorkerConfig } from '../src/config.js';
import { createS3AssetStorage } from '../src/infrastructure/storage/s3-asset-storage.js';
import { PostgresPhotoProjectRepository } from '../src/infrastructure/postgres/photo-project-repository.js';

const config = loadWorkerConfig(process.env);
const pool = new pg.Pool({ connectionString: config.databaseUrl });
const storage = createS3AssetStorage(config.s3);
const key = 'users/dev/projects/smoke/0bf0af80-cc09-412e-8dd9-e4bec786b26b.png';
const head = await storage.get(key);
console.error(`base image ok: ${head.bytes.length} bytes, ${head.contentType}`);

const repository = new PostgresPhotoProjectRepository({ pool });
const project = await repository.createProject({
  projectId: 'smoke_agent_1',
  name: 'Agent Smoke',
  initialState: {
    subject: { identity: { preserve: true } },
    scene: { background: 'photo studio', lighting: 'soft' },
    appearance: { outfit: 'casual' },
    composition: { shot: 'medium' },
    constraints: [],
  },
  anchorAsset: {
    assetId: 'asset_smoke_base',
    uri: `s3://${config.s3.bucket}/${key}`,
    metadata: { contentType: head.contentType },
  },
});
console.error(`project seeded: ${project.id}, revision ${project.activeRevisionId}`);
await pool.end();
