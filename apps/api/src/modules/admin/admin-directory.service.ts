import { Inject, Injectable } from "@nestjs/common";
import { uuidSchema } from "@bizora/contracts";
import { and, count, desc, eq, gte, ilike, inArray, isNull, max, or, sql, sum, type SQL } from "drizzle-orm";
import { ApiError } from "../../common/errors.js";
import type { AppDatabase } from "../../db/database.js";
import {
  aiUsage,
  auditEvents,
  branches,
  businesses,
  invitations,
  memberships,
  organizationLogos,
  organizationPlans,
  organizations,
  plans,
  productPhotos,
  products,
  customers,
  sales,
  sessions,
  shopDevices,
  userIdentities,
  users,
} from "../../db/schema.js";
import { DB } from "../../tokens.js";

const RESULTS = 25;

function like(q: string) {
  return `%${q.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

function dayString(daysAgo: number) {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

function shopStatus(branch: { closedAt: Date | null; lockedAt: Date | null }) {
  if (branch.closedAt) return "closed" as const;
  if (branch.lockedAt) return "locked" as const;
  return "open" as const;
}

/**
 * What Bizora staff can look up about a business or a person (ADR-037): account details, sign-in details and usage.
 * Sales, money and customers are not here; looking at those needs the owner's consent (Admin portal part 2).
 */
@Injectable()
export class AdminDirectoryService {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async searchBusinesses(q: string) {
    const term = q.trim();
    const where: SQL[] = [];
    if (term) {
      const pattern = like(term);
      const owners = this.db
        .select({ tenantId: memberships.tenantId })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(ilike(users.email, pattern));
      const matches: SQL[] = [
        ilike(organizations.name, pattern),
        ilike(organizations.handle, pattern),
        inArray(organizations.id, owners),
        ilike(sql`coalesce(${organizations.phoneE164}, '')`, pattern),
      ];
      if (uuidSchema.safeParse(term).success) matches.push(eq(organizations.id, term));
      where.push(or(...matches)!);
    }
    const rows = await this.db
      .select({
        id: organizations.id,
        name: organizations.name,
        handle: organizations.handle,
        createdAt: organizations.createdAt,
        planCode: organizationPlans.planCode,
      })
      .from(organizations)
      .leftJoin(organizationPlans, eq(organizationPlans.tenantId, organizations.id))
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(organizations.createdAt))
      .limit(RESULTS);
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    const [shopCounts, ownerRows] = await Promise.all([
      this.db
        .select({ tenantId: branches.tenantId, shops: count() })
        .from(branches)
        .where(and(inArray(branches.tenantId, ids), isNull(branches.closedAt)))
        .groupBy(branches.tenantId),
      this.db
        .select({ tenantId: memberships.tenantId, email: users.email, name: users.displayName })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(inArray(memberships.tenantId, ids), eq(memberships.role, "OWNER"))),
    ]);
    return rows.map((row) => {
      const owner = ownerRows.find((entry) => entry.tenantId === row.id);
      return {
        id: row.id,
        name: row.name,
        handle: row.handle,
        plan: row.planCode,
        signedUpAt: row.createdAt.toISOString(),
        openShops: Number(shopCounts.find((entry) => entry.tenantId === row.id)?.shops ?? 0),
        owner: owner ? { name: owner.name, email: owner.email } : null,
      };
    });
  }

  async business(tenantId: string) {
    if (!uuidSchema.safeParse(tenantId).success) throw new ApiError("NOT_FOUND", "Business was not found.", 404);
    const [organization] = await this.db.select().from(organizations).where(eq(organizations.id, tenantId)).limit(1);
    if (!organization) throw new ApiError("NOT_FOUND", "Business was not found.", 404);
    const since = dayString(29);
    const today = dayString(0);
    const counted = await this.counts(tenantId);
    const [plan, businessRows, branchRows, people, pending, devices, reads, photos, logo, lastSession, lastAudit] = await Promise.all([
      this.db
        .select({ code: organizationPlans.planCode, name: plans.name, startedAt: organizationPlans.startedAt })
        .from(organizationPlans)
        .innerJoin(plans, eq(plans.code, organizationPlans.planCode))
        .where(eq(organizationPlans.tenantId, tenantId))
        .limit(1),
      this.db.select().from(businesses).where(eq(businesses.tenantId, tenantId)).orderBy(businesses.createdAt),
      this.db.select().from(branches).where(eq(branches.tenantId, tenantId)).orderBy(branches.createdAt),
      this.db
        .select({
          membershipId: memberships.id,
          userId: users.id,
          name: users.displayName,
          email: users.email,
          kind: users.kind,
          role: memberships.role,
          status: memberships.status,
          branchId: memberships.branchId,
          emailVerifiedAt: users.emailVerifiedAt,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(eq(memberships.tenantId, tenantId))
        .orderBy(memberships.createdAt),
      this.db
        .select()
        .from(invitations)
        .where(and(eq(invitations.tenantId, tenantId), eq(invitations.status, "PENDING")))
        .orderBy(desc(invitations.createdAt)),
      this.db.select().from(shopDevices).where(eq(shopDevices.tenantId, tenantId)).orderBy(desc(shopDevices.createdAt)),
      this.db
        .select({ branchId: aiUsage.branchId, reads: sum(aiUsage.captures), today: sql<number>`coalesce(sum(case when ${aiUsage.day} = ${today} then ${aiUsage.captures} else 0 end), 0)` })
        .from(aiUsage)
        .where(and(eq(aiUsage.tenantId, tenantId), gte(aiUsage.day, since)))
        .groupBy(aiUsage.branchId),
      this.db
        .select({ photos: count(), bytes: sum(productPhotos.byteSize) })
        .from(productPhotos)
        .where(eq(productPhotos.tenantId, tenantId)),
      this.db.select({ bytes: organizationLogos.byteSize }).from(organizationLogos).where(eq(organizationLogos.tenantId, tenantId)).limit(1),
      this.db.select({ at: max(sessions.lastUsedAt) }).from(sessions).where(eq(sessions.tenantId, tenantId)),
      this.db.select({ at: max(auditEvents.createdAt) }).from(auditEvents).where(eq(auditEvents.tenantId, tenantId)),
    ]);
    const lastActivity = [lastSession[0]?.at, lastAudit[0]?.at]
      .filter((value): value is Date => value instanceof Date || typeof value === "string")
      .map((value) => new Date(value))
      .sort((a, b) => b.getTime() - a.getTime())[0];
    const shopName = (id: string | null) => branchRows.find((branch) => branch.id === id)?.name ?? null;
    const lastSeenByUser = people.length
      ? await this.db
          .select({ userId: sessions.userId, at: max(sessions.lastUsedAt) })
          .from(sessions)
          .where(and(eq(sessions.tenantId, tenantId), inArray(sessions.userId, people.map((person) => person.userId))))
          .groupBy(sessions.userId)
      : [];
    return {
      id: organization.id,
      name: organization.name,
      handle: organization.handle,
      sample: organization.isSample,
      phone: organization.phoneE164,
      signedUpAt: organization.createdAt.toISOString(),
      setUpAt: organization.onboardingCompletedAt?.toISOString() ?? null,
      lastActivityAt: lastActivity?.toISOString() ?? null,
      plan: plan[0] ? { code: plan[0].code, name: plan[0].name, since: plan[0].startedAt.toISOString() } : null,
      businesses: businessRows.map((business) => ({
        id: business.id,
        name: business.name,
        type: business.businessType,
        country: business.countryCode,
        currency: business.baseCurrencyCode,
        timezone: business.timezone,
      })),
      shops: branchRows.map((branch) => {
        const usage = reads.find((entry) => entry.branchId === branch.id);
        return {
          id: branch.id,
          name: branch.name,
          business: businessRows.find((business) => business.id === branch.businessId)?.name ?? null,
          status: shopStatus(branch),
          lockedAt: branch.lockedAt?.toISOString() ?? null,
          closedAt: branch.closedAt?.toISOString() ?? null,
          aiReadsToday: Number(usage?.today ?? 0),
          aiReads30Days: Number(usage?.reads ?? 0),
        };
      }),
      people: people.map((person) => ({
        userId: person.userId,
        name: person.name,
        email: person.email,
        signsInWith: person.kind === "staff" ? "pin" : "email",
        role: person.role,
        status: person.status,
        shop: shopName(person.branchId),
        emailVerified: Boolean(person.emailVerifiedAt),
        lastSeenAt: toIso(lastSeenByUser.find((entry) => entry.userId === person.userId)?.at),
      })),
      invitations: pending.map((invite) => ({
        id: invite.id,
        email: invite.email,
        role: invite.role,
        shop: shopName(invite.branchId),
        sentAt: invite.createdAt.toISOString(),
        expiresAt: invite.expiresAt.toISOString(),
        expired: invite.expiresAt.getTime() < Date.now(),
      })),
      devices: devices.map((device) => ({
        id: device.id,
        name: device.name,
        shop: shopName(device.branchId),
        addedAt: device.createdAt.toISOString(),
        lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
        status: device.revokedAt ? "stopped" : device.suspendedAt ? "suspended" : "active",
      })),
      storage: {
        productPhotos: Number(photos[0]?.photos ?? 0),
        bytes: Number(photos[0]?.bytes ?? 0) + Number(logo[0]?.bytes ?? 0),
      },
      usage: counted,
    };
  }

  /** How much the business uses Bizora (ADR-039): counts only, never amounts. */
  private async counts(tenantId: string) {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const [[sold], [items], [people]] = await Promise.all([
      this.db.select({ n: count() }).from(sales).where(and(eq(sales.tenantId, tenantId), gte(sales.soldAt, since))),
      this.db.select({ n: count() }).from(products).where(and(eq(products.tenantId, tenantId), isNull(products.archivedAt))),
      this.db.select({ n: count() }).from(customers).where(and(eq(customers.tenantId, tenantId), isNull(customers.archivedAt))),
    ]);
    return { sales30Days: Number(sold?.n ?? 0), products: Number(items?.n ?? 0), customers: Number(people?.n ?? 0) };
  }

  async searchPeople(q: string) {
    const term = q.trim();
    if (!term) return { people: [], invitations: [] };
    const pattern = like(term);
    const matches: SQL[] = [ilike(sql`coalesce(${users.email}, '')`, pattern), ilike(users.displayName, pattern)];
    if (uuidSchema.safeParse(term).success) matches.push(eq(users.id, term));
    const [people, invites] = await Promise.all([
      this.db
        .select({ id: users.id, name: users.displayName, email: users.email, kind: users.kind, verified: users.emailVerifiedAt, createdAt: users.createdAt })
        .from(users)
        .where(and(eq(users.kind, "person"), or(...matches)))
        .orderBy(desc(users.createdAt))
        .limit(RESULTS),
      this.db
        .select({ id: invitations.id, email: invitations.email, role: invitations.role, tenantId: invitations.tenantId, business: organizations.name, expiresAt: invitations.expiresAt })
        .from(invitations)
        .innerJoin(organizations, eq(organizations.id, invitations.tenantId))
        .where(and(eq(invitations.status, "PENDING"), ilike(invitations.email, pattern)))
        .orderBy(desc(invitations.createdAt))
        .limit(RESULTS),
    ]);
    const workplaces = people.length ? await this.workplaces(people.map((person) => person.id)) : [];
    return {
      people: people.map((person) => ({
        id: person.id,
        name: person.name,
        email: person.email,
        emailVerified: Boolean(person.verified),
        signedUpAt: person.createdAt.toISOString(),
        businesses: workplaces.filter((entry) => entry.userId === person.id).map(({ userId: _userId, ...rest }) => rest),
      })),
      invitations: invites.map((invite) => ({ ...invite, expiresAt: invite.expiresAt.toISOString(), expired: invite.expiresAt.getTime() < Date.now() })),
    };
  }

  async person(userId: string) {
    if (!uuidSchema.safeParse(userId).success) throw new ApiError("NOT_FOUND", "Person was not found.", 404);
    const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new ApiError("NOT_FOUND", "Person was not found.", 404);
    const [workplaces, identities, active] = await Promise.all([
      this.workplaces([user.id]),
      this.db.select({ provider: userIdentities.provider, lastUsedAt: userIdentities.lastUsedAt }).from(userIdentities).where(eq(userIdentities.userId, user.id)),
      this.db
        .select({ sessions: count(), lastSeenAt: max(sessions.lastUsedAt) })
        .from(sessions)
        .where(and(eq(sessions.userId, user.id), isNull(sessions.revokedAt), sql`${sessions.expiresAt} > now()`)),
    ]);
    const pending = user.email
      ? await this.db
          .select({ id: invitations.id, role: invitations.role, business: organizations.name, tenantId: invitations.tenantId, expiresAt: invitations.expiresAt })
          .from(invitations)
          .innerJoin(organizations, eq(organizations.id, invitations.tenantId))
          .where(and(eq(invitations.status, "PENDING"), sql`lower(${invitations.email}) = ${user.email.toLowerCase()}`))
      : [];
    return {
      id: user.id,
      name: user.displayName,
      email: user.email,
      signsInWith: user.kind === "staff" ? ["pin"] : [...(user.passwordHash ? ["password"] : []), ...identities.map((identity) => identity.provider)],
      emailVerified: Boolean(user.emailVerifiedAt),
      signedUpAt: user.createdAt.toISOString(),
      signedInDevices: Number(active[0]?.sessions ?? 0),
      lastSeenAt: toIso(active[0]?.lastSeenAt),
      businesses: workplaces.map(({ userId: _userId, ...rest }) => rest),
      invitations: pending.map((invite) => ({ ...invite, expiresAt: invite.expiresAt.toISOString(), expired: invite.expiresAt.getTime() < Date.now() })),
    };
  }

  /** The businesses a person belongs to, for tagging support actions in each business's own log. */
  async workplaces(userIds: string[]) {
    return this.db
      .select({ userId: memberships.userId, tenantId: memberships.tenantId, business: organizations.name, role: memberships.role, status: memberships.status })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.tenantId))
      .where(inArray(memberships.userId, userIds));
  }

  async device(id: string) {
    if (!uuidSchema.safeParse(id).success) return null;
    const [device] = await this.db.select({ tenantId: shopDevices.tenantId, name: shopDevices.name }).from(shopDevices).where(eq(shopDevices.id, id)).limit(1);
    return device ?? null;
  }

  async invitation(id: string) {
    if (!uuidSchema.safeParse(id).success) return null;
    const [invite] = await this.db.select({ tenantId: invitations.tenantId, email: invitations.email }).from(invitations).where(eq(invitations.id, id)).limit(1);
    return invite ?? null;
  }
}

function toIso(value: Date | string | null | undefined) {
  if (!value) return null;
  return new Date(value).toISOString();
}
