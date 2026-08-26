/**
 * 访问控制端口：路由层只问"这个用户能不能对这个资源做这件事"，
 * 不关心策略怎么实现（认证/授权由组合根注入具体实现）。
 *
 * 约定：拒绝一律抛 HttpError(404)——不向无权者暴露资源是否存在。
 */

import { ErrorCode } from "@/domain/errors";
import { HttpError } from "@/api/http-error";

export interface ResourceOwner {
  ownerId: string;
}

export type AccessAction = "read" | "write";

export interface AccessPolicy {
  assertAccess(input: { userId: string; resource: ResourceOwner; action: AccessAction }): void;
}

/** 测试替身：显式注入，生产组合根不使用。 */
export class AllowAllAccessPolicy implements AccessPolicy {
  assertAccess(): void {
    // no-op
  }
}

/** 认证后的默认授权策略：用户只能访问自己的资源，拒绝一律 404。 */
export class OwnerOnlyAccessPolicy implements AccessPolicy {
  assertAccess({ userId, resource }: { userId: string; resource: ResourceOwner }): void {
    if (resource.ownerId !== userId) {
      throw new HttpError(404, ErrorCode.PROJECT_NOT_FOUND, "Project not found");
    }
  }
}
