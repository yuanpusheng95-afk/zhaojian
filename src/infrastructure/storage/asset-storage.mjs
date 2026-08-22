/**
 * 对象存储 Port。只定义契约与不依赖具体实现的辅助。
 *
 * 不提供 delete()：垃圾回收是 non-goal（设计文档 §16），MVP 无人调用，
 * 加一个死方法会让人以为清理逻辑已经存在。
 */

const EXTENSION_BY_CONTENT_TYPE = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/webp', 'webp'],
]);

const REQUIRED_METHODS = ['put', 'get', 'getSignedUrl'];
const REQUIRED_FIELDS = ['bucket'];

export function assertAssetStorage(storage) {
  for (const method of REQUIRED_METHODS) {
    if (typeof storage?.[method] !== 'function') {
      throw new TypeError(`Asset storage must implement ${method}()`);
    }
  }
  for (const field of REQUIRED_FIELDS) {
    if (typeof storage?.[field] !== 'string' || storage[field] === '') {
      throw new TypeError(`Asset storage must expose ${field}`);
    }
  }
  return storage;
}

/**
 * assets.uri 存完整的 `s3://<bucket>/<key>`，不是裸 key。
 *
 * 写侧与读侧在同一处定义，**不可能只改一边**——这正是断链的成因：
 * 2a 的 storage 用裸 key，2b 的落库写 s3:// URI，两套约定从未同时跑过。
 */
export function buildAssetUri(bucket, key) {
  if (typeof bucket !== 'string' || bucket === '') {
    throw new TypeError('buildAssetUri requires a bucket');
  }
  if (typeof key !== 'string' || key === '') {
    throw new TypeError('buildAssetUri requires a key');
  }
  return `s3://${bucket}/${key}`;
}

export class InvalidAssetUriError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidAssetUriError';
    this.code = 'INVALID_ASSET_URI';
  }
}

/** `s3://<bucket>/<key>` → `<key>`。bucket 不符或格式非法一律拒绝，不猜。 */
export function resolveAssetStorageKey(uri, bucket) {
  if (typeof uri !== 'string' || !uri.startsWith('s3://')) {
    throw new InvalidAssetUriError(`Asset uri must start with s3://, got: ${uri}`);
  }
  const rest = uri.slice('s3://'.length);
  const slash = rest.indexOf('/');
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

/**
 * 对象键按 users/{ownerId}/projects/{projectId}/{assetId}.{ext} 组织。
 *
 * 扩展名由 content type 推导，不写死 .png——图像模型可能返回 webp 或 jpeg，
 * 写死会让文件名骗人（设计文档 §6.2）。
 */
export function buildAssetKey({ ownerId, projectId, assetId, contentType }) {
  for (const [name, value] of Object.entries({
    ownerId,
    projectId,
    assetId,
    contentType,
  })) {
    if (typeof value !== 'string' || value === '') {
      throw new TypeError(`buildAssetKey requires a non-empty ${name}`);
    }
  }
  const extension = EXTENSION_BY_CONTENT_TYPE.get(
    contentType.toLowerCase().split(';')[0].trim(),
  );
  if (!extension) {
    throw new TypeError(`Unsupported image content type: ${contentType}`);
  }
  return `users/${ownerId}/projects/${projectId}/${assetId}.${extension}`;
}
