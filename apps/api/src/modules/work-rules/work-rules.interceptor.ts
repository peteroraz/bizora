import { type CallHandler, type ExecutionContext, Inject, Injectable, type NestInterceptor } from "@nestjs/common";
import type { Request } from "express";
import { from, type Observable, switchMap } from "rxjs";
import { ApiError } from "../../common/errors.js";
import { TENANT_CONTEXT_KEY, type TenantContext } from "../../common/tenant-context.js";
import { WorkRulesService } from "./work-rules.service.js";

const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Writes that are not changes to the books, so staff can still sign in and out, leave a shop phone, read their
 * notifications and choose their shop when the business is closed or their shop is locked. Offline work that syncs is
 * accepted and flagged instead (see SyncService).
 */
const ALWAYS_ALLOWED = [
  /^\/api\/v1\/auth\//,
  /^\/api\/v1\/shop\//,
  /^\/api\/v1\/public\//,
  /^\/api\/v1\/sync\/push$/,
  /^\/api\/v1\/shop-devices\/current\/exit$/,
  /^\/api\/v1\/notifications\/read$/,
  /^\/api\/v1\/invitations\/accept$/,
  /^\/api\/v1\/memberships\/[^/]+\/default-shop$/,
];

/**
 * Shop locks and opening hours (ADR-034), checked on every change after the person is known and before anything
 * runs. The owner is never stopped. Reading is never stopped.
 */
@Injectable()
export class WorkRulesInterceptor implements NestInterceptor {
  constructor(@Inject(WorkRulesService) private readonly rules: WorkRulesService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();
    const request = context.switchToHttp().getRequest<Request & { [TENANT_CONTEXT_KEY]?: TenantContext }>();
    const tenant = request[TENANT_CONTEXT_KEY];
    if (!tenant || !WRITES.has(request.method) || ALWAYS_ALLOWED.some((pattern) => pattern.test(request.path))) return next.handle();
    const body = (request.body ?? {}) as Record<string, unknown>;
    const named = ["branchId", "fromBranchId", "toBranchId"].map((key) => (typeof body[key] === "string" ? (body[key] as string) : null));
    return from(this.rules.refusal(tenant, [tenant.branchId, tenant.membershipBranchId, ...named])).pipe(
      switchMap((refusal) => {
        if (refusal) throw new ApiError(refusal.code, refusal.message, 423);
        return next.handle();
      }),
    );
  }
}
