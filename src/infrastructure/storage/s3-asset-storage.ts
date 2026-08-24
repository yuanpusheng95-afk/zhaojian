import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl as presign } from "@aws-sdk/s3-request-presigner";

import { assertAssetStorage } from "./asset-storage.js";

export function createS3AssetStorage({
  endpoint,
  publicEndpoint = endpoint,
  bucket,
  accessKey,
  secretKey,
  region = "us-east-1",
  forcePathStyle = true,
}: {
  endpoint: string;
  publicEndpoint?: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region?: string;
  forcePathStyle?: boolean;
}) {
  if (!bucket) throw new TypeError("createS3AssetStorage requires a bucket");

  const client = new S3Client({
    endpoint,
    region,
    forcePathStyle,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  });
  const signingClient = publicEndpoint === endpoint
    ? client
    : new S3Client({
      endpoint: publicEndpoint,
      region,
      forcePathStyle,
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    });

  let ensured: Promise<void> | undefined;
  async function ensureBucket(): Promise<void> {
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

    async put(key: string, bytes: Buffer | Uint8Array, contentType: string): Promise<void> {
      await ensureBucket();
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType }),
      );
    },

    async get(key: string): Promise<{ bytes: Buffer; contentType?: string }> {
      await ensureBucket();
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const chunks: Uint8Array[] = [];
      for await (const chunk of result.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
      return { bytes: Buffer.concat(chunks), contentType: result.ContentType };
    },

    async getSignedUrl(key: string, { expiresInSeconds = 900 }: { expiresInSeconds?: number } = {}): Promise<string> {
      await ensureBucket();
      return presign(signingClient, new GetObjectCommand({ Bucket: bucket, Key: key }), {
        expiresIn: expiresInSeconds,
      });
    },
  });
}
