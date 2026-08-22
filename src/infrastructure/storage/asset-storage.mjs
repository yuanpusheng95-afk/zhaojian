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

export function assertAssetStorage(storage) {
  for (const method of REQUIRED_METHODS) {
    if (typeof storage?.[method] !== 'function') {
      throw new TypeError(`Asset storage must implement ${method}()`);
    }
  }
  return storage;
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
