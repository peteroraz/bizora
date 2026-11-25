import { randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { readCookieValue, sha256Hex } from "@bizora/auth";
import type { AppEnv } from "@bizora/config/env";
import { ADMIN_ROLES, type AdminRole } from "@bizora/contracts";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { CookieOptions, Request, Response } from "express";
import { ApiError } from "../../common/errors.js";
import { newId } from "../../common/ids.js";
import type { AppDatabase } from "../../db/database.js";
import { adminSessions, adminStaff } from "../../db/schema.js";
import { APP_ENV, DB } from "../../tokens.js";
import type { OauthProfile } from "../identity/oauth.service.js";
import { AdminAuditService } from "./admin-audit.service.js";

/** Staff sessions last one working day, then Google sign-in again (ADR-037). */
export const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export type AdminStaffMember = {
  staffId: string;
  sessionId: string;
  email: string;
  name: string;
  roles: AdminRole[];
  /** When this portal session began, for actions that need a fresh sign-in (ADR-071). */
  signedInAt: Date;
};

/** `__Host-` cookies are tied to the portal's own address and cannot be set by any other site (needs HTTPS). */
export function adminSessionCookie(env: AppEnv) {
  return env.COOKIE_SECURE ? "__Host-bizora_admin" : "bizora_admin";
}

export function adminCookieOptions(env: AppEnv, maxAge: number): CookieOptions {
  return { httpOnly: true, secure: env.COOKIE_SECURE, sameSite: "lax", path: "/", maxAge };
}

export function bootstrapEmails(env: AppEnv): string[] {
  return (env.ADMIN_BOOTSTRAP_EMAILS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.includes("@"));
}

export type SignInRefusal = "unverified" | "not_allowed" | "removed" | "different_account";

@Injectable()
export class AdminSessionService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(AdminAuditService) private readonly audit: AdminAuditService,
  ) {}

  /**
   * Only allow-listed Google accounts get in. The first time a bootstrap email signs in it becomes a super admin;
   * after that, super admins add everyone else. The Google account is pinned on first sign-in.
   */
  async signIn(profile: OauthProfile, meta: { ip: string | null; userAgent: string | null }): Promise<{ token: string } | { refused: SignInRefusal }> {
    const email = profile.email.toLowerCase();
    const refuse = async (refused: SignInRefusal, staffId: string | null = null) => {
      await this.audit.record({ staffId, staffEmail: email, action: "staff.sign_in_refused", metadata: { why: refused }, ip: meta.ip });
      return { refused };
    };
    if (!profile.emailVerified) return refuse("unverified");
    let [staff] = await this.db.select().from(adminStaff).where(sql`lower(${adminStaff.email}) = ${email}`).limit(1);
    if (!staff) {
      if (!bootstrapEmails(this.env).includes(email)) return refuse("not_allowed");
      [staff] = await this.db
        .insert(adminStaff)
        .values({ id: newId(), email, name: profile.displayName.slice(0, 160), roles: ["super_admin"] })
        .onConflictDoNothing()
        .returning();
      if (!staff) return refuse("not_allowed");
      await this.audit.record({ staffId: staff.id, staffEmail: email, action: "staff.bootstrapped", metadata: { roles: ["super_admin"] }, ip: meta.ip });
    }
    if (staff.status !== "active") return refuse("removed", staff.id);
    if (staff.googleSubject && staff.googleSubject !== profile.subject) return refuse("different_account", staff.id);
    await this.db
      .update(adminStaff)
      .set({ googleSubject: profile.subject, lastSignInAt: new Date(), ...(staff.name ? {} : { name: profile.displayName.slice(0, 160) }) })
      .where(eq(adminStaff.id, staff.id));
    const token = randomBytes(32).toString("base64url");
    await this.db.insert(adminSessions).values({
      id: newId(),
      staffId: staff.id,
      tokenHash: sha256Hex(token),
      expiresAt: new Date(Date.now() + ADMIN_SESSION_TTL_MS),
      ip: meta.ip,
      userAgent: meta.userAgent?.slice(0, 512) ?? null,
    });
    await this.audit.record({ staffId: staff.id, staffEmail: email, action: "staff.signed_in", ip: meta.ip });
    return { token };
  }

  async resolve(request: Request): Promise<AdminStaffMember | null> {
    const token = readCookieValue(request.headers.cookie, adminSessionCookie(this.env));
    if (!token) return null;
    const [row] = await this.db
      .select({
        sessionId: adminSessions.id,
        signedInAt: adminSessions.createdAt,
        staffId: adminStaff.id,
        email: adminStaff.email,
        name: adminStaff.name,
        roles: adminStaff.roles,
        status: adminStaff.status,
      })
      .from(adminSessions)
      .innerJoin(adminStaff, eq(adminStaff.id, adminSessions.staffId))
      .where(
        and(
          eq(adminSessions.tokenHash, sha256Hex(decodeURIComponent(token))),
          isNull(adminSessions.revokedAt),
          gt(adminSessions.expiresAt, sql`now()`),
        ),
      )
      .limit(1);
    if (!row || row.status !== "active") return null;
    const roles = row.roles.filter((role): role is AdminRole => (ADMIN_ROLES as readonly string[]).includes(role));
    return { sessionId: row.sessionId, staffId: row.staffId, email: row.email, name: row.name, roles, signedInAt: row.signedInAt };
  }

  async signOut(member: AdminStaffMember, ip: string | null) {
    await this.db.update(adminSessions).set({ revokedAt: new Date() }).where(eq(adminSessions.id, member.sessionId));
    await this.audit.record({ staffId: member.staffId, staffEmail: member.email, action: "staff.signed_out", ip });
  }

  async revokeAllFor(staffId: string) {
    await this.db
      .update(adminSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(adminSessions.staffId, staffId), isNull(adminSessions.revokedAt)));
  }

  writeCookie(res: Response, token: string) {
    res.cookie(adminSessionCookie(this.env), token, adminCookieOptions(this.env, ADMIN_SESSION_TTL_MS));
  }

  clearCookie(res: Response) {
    const { maxAge: _maxAge, ...options } = adminCookieOptions(this.env, 0);
    res.clearCookie(adminSessionCookie(this.env), options);
  }

  requireEnabled() {
    if (!this.env.ADMIN_WEB_ORIGIN) throw new ApiError("ADMIN_DISABLED", "The Admin portal is not turned on here.", 404);
    return this.env.ADMIN_WEB_ORIGIN.replace(/\/$/, "");
  }
}
