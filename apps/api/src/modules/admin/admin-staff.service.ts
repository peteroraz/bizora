import { Inject, Injectable } from "@nestjs/common";
import { adminStaffAddSchema, adminStaffRolesSchema, uuidSchema, type AdminRole } from "@bizora/contracts";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import type { AppDatabase } from "../../db/database.js";
import { adminStaff } from "../../db/schema.js";
import { DB } from "../../tokens.js";
import { AdminAuditService } from "./admin-audit.service.js";
import { AdminSessionService, type AdminStaffMember } from "./admin-session.service.js";

type Row = typeof adminStaff.$inferSelect;

function present(row: Row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    roles: row.roles,
    status: row.status,
    lastSignInAt: row.lastSignInAt?.toISOString() ?? null,
    addedAt: row.createdAt.toISOString(),
  };
}

function validation(issues: { path: (string | number)[]; message: string }[]) {
  const fieldErrors = issues.map((issue) => ({ field: String(issue.path[0] ?? "form"), message: issue.message }));
  return new ApiError("VALIDATION_FAILED", "Check the details.", 400, fieldErrors);
}

/** Super admins keep the allow-list of Bizora staff (ADR-037). There is always at least one super admin. */
@Injectable()
export class AdminStaffService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(AdminAuditService) private readonly audit: AdminAuditService,
    @Inject(AdminSessionService) private readonly sessions: AdminSessionService,
  ) {}

  async list() {
    const rows = await this.db.select().from(adminStaff).orderBy(asc(adminStaff.status), asc(adminStaff.email));
    return rows.map(present);
  }

  async add(raw: unknown, by: AdminStaffMember, ip: string | null) {
    const parsed = adminStaffAddSchema.safeParse(raw ?? {});
    if (!parsed.success) throw validation(parsed.error.issues);
    const { email, name, roles } = parsed.data;
    const [existing] = await this.db.select().from(adminStaff).where(sql`lower(${adminStaff.email}) = ${email}`).limit(1);
    let row: Row | undefined;
    if (existing?.status === "active") throw new ApiError("STAFF_EXISTS", "This email is already on the staff list.", 409);
    if (existing) {
      // Someone who left and came back: same record, fresh roles, and their Google account is checked again.
      [row] = await this.db
        .update(adminStaff)
        .set({ status: "active", name, roles, googleSubject: null, removedAt: null, removedBy: null, createdBy: by.staffId })
        .where(eq(adminStaff.id, existing.id))
        .returning();
    } else {
      [row] = await this.db.insert(adminStaff).values({ id: newId(), email, name, roles, createdBy: by.staffId }).returning();
    }
    await this.audit.record({ staffId: by.staffId, staffEmail: by.email, action: "staff.added", targetType: "staff", targetId: row!.id, metadata: { email, roles }, ip });
    return present(row!);
  }

  async changeRoles(id: string, raw: unknown, by: AdminStaffMember, ip: string | null) {
    const parsed = adminStaffRolesSchema.safeParse(raw ?? {});
    if (!parsed.success) throw validation(parsed.error.issues);
    const target = await this.require(id);
    const roles = [...new Set(parsed.data.roles)] as AdminRole[];
    if (target.roles.includes("super_admin") && !roles.includes("super_admin")) await this.keepOneSuperAdmin(target.id);
    const [row] = await this.db.update(adminStaff).set({ roles }).where(eq(adminStaff.id, target.id)).returning();
    await this.audit.record({
      staffId: by.staffId,
      staffEmail: by.email,
      action: "staff.roles_changed",
      targetType: "staff",
      targetId: target.id,
      reason: parsed.data.reason,
      metadata: { email: target.email, from: target.roles, to: roles },
      ip,
    });
    return present(row!);
  }

  async remove(id: string, reason: string, by: AdminStaffMember, ip: string | null) {
    const target = await this.require(id);
    if (target.id === by.staffId) throw new ApiError("STAFF_SELF", "You cannot remove yourself. Ask another super admin.", 409);
    if (target.roles.includes("super_admin")) await this.keepOneSuperAdmin(target.id);
    const [row] = await this.db
      .update(adminStaff)
      .set({ status: "removed", removedAt: new Date(), removedBy: by.staffId })
      .where(eq(adminStaff.id, target.id))
      .returning();
    await this.sessions.revokeAllFor(target.id);
    await this.audit.record({ staffId: by.staffId, staffEmail: by.email, action: "staff.removed", targetType: "staff", targetId: target.id, reason, metadata: { email: target.email }, ip });
    return present(row!);
  }

  private async require(id: string) {
    if (!uuidSchema.safeParse(id).success) throw new ApiError("NOT_FOUND", "Staff member was not found.", 404);
    const [row] = await this.db.select().from(adminStaff).where(and(eq(adminStaff.id, id), eq(adminStaff.status, "active"))).limit(1);
    if (!row) throw new ApiError("NOT_FOUND", "Staff member was not found.", 404);
    return row;
  }

  private async keepOneSuperAdmin(leaving: string) {
    const others = await this.db
      .select({ id: adminStaff.id })
      .from(adminStaff)
      .where(and(eq(adminStaff.status, "active"), ne(adminStaff.id, leaving), sql`'super_admin' = ANY(${adminStaff.roles})`))
      .limit(1);
    if (!others.length) throw new ApiError("LAST_SUPER_ADMIN", "There must always be one super admin. Add another first.", 409);
  }
}
