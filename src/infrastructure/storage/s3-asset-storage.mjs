import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl as presign } from '@aws-sdk/s3-request-presigner';

import { assertAssetStorage } from './asset-storage.mjs';

/**
 * S3 兼容实现，同一套代码覆盖 MinIO / 阿里云 OSS / 腾讯 COS。
 *
 * forcePathStyle 对 MinIO 必须为 true——它不支持 virtual-host 风格的 bucket 域名。
 */
export function createS3AssetStorage({
  endpoint,
  publicEndpoint = endpoint,
  bucket,
  accessKey,
  secretKey,
  region = 'us-east-1',
  forcePathStyle = true,
}) {
  if (!bucket) throw new TypeError('createS3AssetStorage requires a bucket');

  const client = new S3Client({
    endpoint,
    region,
    forcePathStyle,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  });
  // 签名专用客户端:容器内用内网端点做读写,但签名 URL 的 host 必须浏览器可达
  // (SigV4 对 host 签名,宿主转发保留 Host 头,所以公网端点签名 + 内网读写可并存)
  const signingClient = publicEndpoint === endpoint
    ? client
    : new S3Client({
      endpoint: publicEndpoint,
      region,
      forcePathStyle,
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    });

  let ensured;
  /** MinIO 首次使用时 bucket 可能不存在；生产的 OSS/COS 一般已建好，HeadBucket 成功即跳过。 */
  async function ensureBucket() {
    ensured ??= (async () => {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
      }
    })();
    return ensured;
  }

  return assertAssetStorage({
    bucket,

    async put(key, bytes, contentType) {
      await ensureBucket();
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentType: contentType,
        }),
      );
    },

    async get(key) {
      await ensureBucket();
      const result = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      const chunks = [];
      for await (const chunk of result.Body) chunks.push(chunk);
      return {
        bytes: Buffer.concat(chunks),
        contentType: result.ContentType,
      };
    },

    async getSignedUrl(key, { expiresInSeconds = 900 } = {}) {
      await ensureBucket();
      return presign(signingClient, new GetObjectCommand({ Bucket: bucket, Key: key }), {
        expiresIn: expiresInSeconds,
      });
    },
  });
}
