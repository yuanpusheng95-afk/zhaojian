/**
 * 访问控制端口：路由层只问"这个用户能不能对这个资源做这件事"，
 * 不关心策略怎么实现（V1 放行一切，后续接认证/授权时换实现即可）。
 *
 * 约定：拒绝一律抛 HttpError(404)——不向无权者暴露资源是否存在。
 */

import { HttpError } from "./http-error.js";

export interface ResourceOwner {
  ownerId: string;
}

export type AccessAction = "read" | "write";

export interface AccessPolicy {
  assertAccess(input: { userId: string; resource: ResourceOwner; action: AccessAction }): void;
}

/** V1 默认实现：没有认证体系，全部放行。 */
export class AllowAllAccessPolicy implements AccessPolicy {
  assertAccess(): void {
    // no-op
  }
}
