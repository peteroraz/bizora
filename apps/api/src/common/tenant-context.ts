import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { Role } from "@bizora/contracts";

export type TenantContext = {
  userId: string;
  tenantId: string;
  businessId: string | null;
  branchId: string | null;
  membershipId: string;
  role: Role;
  correlationId: string;
};

export const TENANT_CONTEXT_KEY = "tenantContext";

export const CurrentTenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): TenantContext => {
    const request = ctx.switchToHttp().getRequest<{ [TENANT_CONTEXT_KEY]?: TenantContext }>();
    const tenant = request[TENANT_CONTEXT_KEY];
    if (!tenant) {
      throw new Error("Tenant context is missing");
    }
    return tenant;
  },
);
