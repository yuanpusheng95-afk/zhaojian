const EXTENSION_BY_CONTENT_TYPE = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/jpg", "jpg"],
  ["image/webp", "webp"],
]);

export interface AssetStorageLike {
  put: (key: string, bytes: Buffer | Uint8Array, contentType: string) => Promise<void>;
  get: (key: string) => Promise<{ bytes: Buffer; contentType?: string }>;
  getSignedUrl: (key: string, options?: { expiresInSeconds?: number }) => Promise<string>;
  bucket: string;
}

export function buildAssetUri(bucket: string, key: string): string {
  if (typeof bucket !== "string" || bucket === "") {
    throw new TypeError("buildAssetUri requires a bucket");
  }
  if (typeof key !== "string" || key === "") {
    throw new TypeError("buildAssetUri requires a key");
  }
  return `s3://${bucket}/${key}`;
}

export class InvalidAssetUriError extends Error {
  code = "INVALID_ASSET_URI";
  constructor(message: string) {
    super(message);
    this.name = "InvalidAssetUriError";
  }
}

export function resolveAssetStorageKey(uri: string, bucket: string): string {
  if (typeof uri !== "string" || !uri.startsWith("s3://")) {
    throw new InvalidAssetUriError(`Asset uri must start with s3://, got: ${uri}`);
  }
  const rest = uri.slice("s3://".length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) {
    throw new InvalidAssetUriError(`Asset uri has no bucket or key: ${uri}`);
  }
  const uriBucket = rest.slice(0, slash);
  if (uriBucket !== bucket) {
    throw new InvalidAssetUriError(
      `Asset uri bucket ${uriBucket} does not match configured bucket ${bucket}`,
    );
  }
  return rest.slice(slash + 1);
}

export function buildAssetKey({ ownerId, projectId, assetId, contentType }: {
  ownerId: string;
  projectId: string;
  assetId: string;
  contentType: string;
}): string {
  for (const [name, value] of Object.entries({ ownerId, projectId, assetId, contentType })) {
    if (typeof value !== "string" || value === "") {
      throw new TypeError(`buildAssetKey requires a non-empty ${name}`);
    }
  }
  const extension = EXTENSION_BY_CONTENT_TYPE.get(contentType.toLowerCase().split(";")[0].trim());
  if (!extension) {
    throw new TypeError(`Unsupported image content type: ${contentType}`);
  }
  return `users/${ownerId}/projects/${projectId}/${assetId}.${extension}`;
}
