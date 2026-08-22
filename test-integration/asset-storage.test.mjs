import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildAssetKey } from '../src/infrastructure/storage/asset-storage.mjs';
import { createS3AssetStorage } from '../src/infrastructure/storage/s3-asset-storage.mjs';

function createStorage() {
  return createS3AssetStorage({
    endpoint: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9000',
    bucket: process.env.S3_BUCKET ?? 'photo-agent-test',
    accessKey: process.env.S3_ACCESS_KEY ?? 'photoagent',
    secretKey: process.env.S3_SECRET_KEY ?? 'photoagent123',
    region: process.env.S3_REGION ?? 'us-east-1',
    forcePathStyle: true,
  });
}

test('buildAssetKey nests by owner and project and derives the extension', () => {
  assert.equal(
    buildAssetKey({
      ownerId: 'dev',
      projectId: 'p1',
      assetId: 'a1',
      contentType: 'image/webp',
    }),
    'users/dev/projects/p1/a1.webp',
  );
  assert.equal(
    buildAssetKey({
      ownerId: 'dev',
      projectId: 'p1',
      assetId: 'a2',
      contentType: 'image/jpeg',
    }),
    'users/dev/projects/p1/a2.jpg',
  );
});

test('buildAssetKey rejects a content type it cannot map', () => {
  assert.throws(
    () =>
      buildAssetKey({
        ownerId: 'dev',
        projectId: 'p1',
        assetId: 'a3',
        contentType: 'application/pdf',
      }),
    /Unsupported image content type/,
  );
});

test('put and get round-trip the exact bytes', async () => {
  const storage = createStorage();
  const key = buildAssetKey({
    ownerId: 'dev',
    projectId: 'roundtrip',
    assetId: `a-${Date.now()}`,
    contentType: 'image/png',
  });
  const bytes = Buffer.from('not-really-a-png-but-bytes-are-bytes');

  await storage.put(key, bytes, 'image/png');
  const fetched = await storage.get(key);

  assert.deepEqual(fetched.bytes, bytes);
  assert.equal(fetched.contentType, 'image/png');
});

test('getSignedUrl returns a URL that serves the object without credentials', async () => {
  const storage = createStorage();
  const key = buildAssetKey({
    ownerId: 'dev',
    projectId: 'signed',
    assetId: `a-${Date.now()}`,
    contentType: 'image/png',
  });
  const bytes = Buffer.from('signed-content');
  await storage.put(key, bytes, 'image/png');

  const url = await storage.getSignedUrl(key, { expiresInSeconds: 60 });
  const response = await fetch(url);

  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
});
