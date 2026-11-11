import { char, index, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by"),
  updatedBy: uuid("updated_by"),
};

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey(),
  name: varchar("name", { length: 160 }).notNull(),
  slug: varchar("slug", { length: 160 }).notNull().unique(),
  logoUrl: varchar("logo_url", { length: 2048 }),
  primaryColor: varchar("primary_color", { length: 7 }).notNull().default("#1D4ED8"),
  accentColor: varchar("accent_color", { length: 7 }).notNull().default("#0F172A"),
  onboardingCompletedAt: timestamp("onboarding_completed_at", { withTimezone: true }),
  ...timestamps,
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  email: varchar("email", { length: 320 }).notNull().unique(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  displayName: varchar("display_name", { length: 120 }).notNull(),
  ...timestamps,
});

export const businesses = pgTable(
  "businesses",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    countryCode: char("country_code", { length: 2 }).notNull(),
    baseCurrencyCode: char("base_currency_code", { length: 3 }).notNull(),
    timezone: varchar("timezone", { length: 64 }).notNull(),
    industryCode: varchar("industry_code", { length: 64 }),
    ...timestamps,
  },
  (table) => [index("businesses_tenant_id_idx").on(table.tenantId)],
);

export const branches = pgTable(
  "branches",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    businessId: uuid("business_id").notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    ...timestamps,
  },
  (table) => [
    index("branches_tenant_id_idx").on(table.tenantId),
    index("branches_business_id_idx").on(table.businessId),
  ],
);

export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    userId: uuid("user_id").notNull(),
    role: varchar("role", { length: 32 }).notNull(),
    businessId: uuid("business_id"),
    branchId: uuid("branch_id"),
    status: varchar("status", { length: 24 }).notNull().default("ACTIVE"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("memberships_tenant_user_idx").on(table.tenantId, table.userId),
    index("memberships_user_id_idx").on(table.userId),
  ],
);

export const permissions = pgTable("permissions", {
  id: uuid("id").primaryKey(),
  code: varchar("code", { length: 64 }).notNull().unique(),
  description: varchar("description", { length: 255 }).notNull(),
});

export const rolePermissions = pgTable(
  "role_permissions",
  {
    role: varchar("role", { length: 32 }).notNull(),
    permissionId: uuid("permission_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.role, table.permissionId] })],
);

export const countryPacks = pgTable("country_packs", {
  code: char("code", { length: 2 }).primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
  defaultCurrencyCode: char("default_currency_code", { length: 3 }).notNull(),
  defaultTimezone: varchar("default_timezone", { length: 64 }).notNull(),
});

export const industryPacks = pgTable("industry_packs", {
  code: varchar("code", { length: 64 }).primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
});

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    email: varchar("email", { length: 320 }).notNull(),
    role: varchar("role", { length: 32 }).notNull(),
    businessId: uuid("business_id"),
    branchId: uuid("branch_id"),
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    status: varchar("status", { length: 24 }).notNull().default("PENDING"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    invitedBy: uuid("invited_by").notNull(),
    acceptedBy: uuid("accepted_by"),
    ...timestamps,
  },
  (table) => [
    index("invitations_tenant_id_idx").on(table.tenantId),
    index("invitations_email_idx").on(table.email),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id"),
    actorUserId: uuid("actor_user_id"),
    action: varchar("action", { length: 64 }).notNull(),
    entityType: varchar("entity_type", { length: 64 }).notNull(),
    entityId: uuid("entity_id"),
    correlationId: varchar("correlation_id", { length: 64 }).notNull(),
    metadataJson: text("metadata_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_events_tenant_id_idx").on(table.tenantId),
    index("audit_events_correlation_id_idx").on(table.correlationId),
  ],
);

export const schema = {
  organizations,
  users,
  businesses,
  branches,
  memberships,
  permissions,
  rolePermissions,
  countryPacks,
  industryPacks,
  invitations,
  auditEvents,
};

export type DatabaseSchema = typeof schema;
