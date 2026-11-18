import { Permission, ROLE_PERMISSIONS } from "@bizora/contracts";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { TenantContext } from "../../common/tenant-context.js";
import type { DbExecutor } from "../../db/database.js";
import { memberships } from "../../db/schema.js";

/**
 * Who checks transfers (ADR-031): the people who can see the bank (bank.reconcile: owner, administrator, accountant).
 * A transfer they record themselves counts as confirmed; one recorded by anyone else waits for them.
 */
const CHECKER_ROLES = Object.entries(ROLE_PERMISSIONS)
  .filter(([, permissions]) => permissions.includes(Permission.BANK_RECONCILE))
  .map(([role]) => role);

/**
 * Whether a transfer recorded now waits for confirmation. Sales typed in from an old book or a photo are past
 * business the owner brings in, so they count as confirmed.
 */
export function transferWaits(tenant: Pick<TenantContext, "permissions">, source: string | undefined) {
  if (source && source !== "pos" && source !== "offline" && source !== "online") return false;
  return !tenant.permissions.includes(Permission.BANK_RECONCILE);
}

/** Active people in the business who can confirm transfers. */
export async function bankCheckers(tx: DbExecutor, tenantId: string, businessId: string) {
  if (CHECKER_ROLES.length === 0) return [];
  const rows = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.tenantId, tenantId),
        eq(memberships.status, "ACTIVE"),
        inArray(memberships.role, CHECKER_ROLES),
        or(isNull(memberships.businessId), eq(memberships.businessId, businessId)),
      ),
    );
  return rows.map((row) => row.id);
}
