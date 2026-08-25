import { ErrorCode } from "../domain/errors.js";
import type { AccessAction, AccessPolicy, ResourceOwner } from "./access-policy.js";
import { HttpError } from "./http-error.js";

/** 登录用户只能访问自己的资源；拒绝一律 404，不暴露资源存在性。 */
export class OwnerOnlyAccessPolicy implements AccessPolicy {
  assertAccess({ userId, resource, action }: { userId: string; resource: ResourceOwner; action: AccessAction }): void {
    if (resource.ownerId !== userId) {
      throw new HttpError(404, ErrorCode.PROJECT_NOT_FOUND, "Project not found");
    }
  }
}
