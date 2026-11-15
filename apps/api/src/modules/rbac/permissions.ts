import { SetMetadata } from "@nestjs/common";
import type { PermissionCode } from "@bizora/contracts";

export const PERMISSIONS_KEY = "permissions";

export const RequirePermissions = (...permissions: PermissionCode[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

export const PERMISSIONS_ANY_KEY = "permissions_any";

/** Allows the request when the caller has at least one of these permissions. The handler then decides what to return. */
export const RequireAnyPermission = (...permissions: PermissionCode[]) => SetMetadata(PERMISSIONS_ANY_KEY, permissions);
