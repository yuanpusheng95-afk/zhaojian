import assert from 'node:assert/strict';
import { describe, expect, test } from 'bun:test';

import {
  buildAssetKey,
  buildAssetUri,
  resolveAssetStorageKey,
} from '../src/infrastructure/storage/asset-storage.js';
import { createS3AssetStorage } from '../src/infrastructure/storage/s3-asset-storage.js';

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

test('buildAssetUri and resolveAssetStorageKey are exact inverses', () => {
  const key = buildAssetKey({
    ownerId: 'dev',
    projectId: 'p1',
    assetId: 'a1',
    contentType: 'image/webp',
  });
  const uri = buildAssetUri('photo-agent', key);

  assert.equal(uri, 's3://photo-agent/users/dev/projects/p1/a1.webp');
  assert.equal(
    resolveAssetStorageKey(uri, 'photo-agent'),
    key,
    '写侧与读侧必须是精确互逆——只改一边就是断链',
  );
});

test('resolveAssetStorageKey refuses a bare key instead of guessing', () => {
  assert.throws(
    () => resolveAssetStorageKey('users/dev/projects/p1/a1.png', 'photo-agent'),
    (error) => error.code === 'INVALID_ASSET_URI',
  );
});

test('resolveAssetStorageKey refuses a uri from another bucket', () => {
  assert.throws(
    () => resolveAssetStorageKey('s3://other-bucket/users/dev/a.png', 'photo-agent'),
    (error) => error.code === 'INVALID_ASSET_URI',
  );
});

test('a uri built for the real bucket round-trips through storage', async () => {
  const storage = createStorage();
  const key = buildAssetKey({
    ownerId: 'dev',
    projectId: 'uri-roundtrip',
    assetId: `a-${Date.now()}`,
    contentType: 'image/png',
  });
  const bytes = Buffer.from('uri-roundtrip-bytes');
  await storage.put(key, bytes, 'image/png');

  // 模拟真实读路径：assets.uri → storage key → 字节
  const uri = buildAssetUri(storage.bucket, key);
  const fetched = await storage.get(resolveAssetStorageKey(uri, storage.bucket));

  assert.deepEqual(fetched.bytes, bytes);
});
