import { sql } from "drizzle-orm";
import type { OpeningHours } from "@bizora/contracts";
import { bigint, boolean, char, check, customType, date, foreignKey, index, integer, jsonb, numeric, pgTable, primaryKey, smallint, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by"),
  updatedBy: uuid("updated_by"),
};

export const countries = pgTable("countries", {
  code: varchar("code", { length: 2 }).primaryKey(),
  name: text("name").notNull(),
  defaultCurrencyCode: varchar("default_currency_code", { length: 3 }).notNull(),
  timezones: text("timezones").array().notNull(),
  callingCode: varchar("calling_code", { length: 16 }),
  subdivisionLabel: text("subdivision_label").notNull(),
  subdivisionRequired: boolean("subdivision_required").notNull(),
  postalCodeRequired: boolean("postal_code_required").notNull(),
  postalCodeRegex: text("postal_code_regex"),
});

export const subdivisions = pgTable(
  "subdivisions",
  {
    countryCode: varchar("country_code", { length: 2 }).notNull(),
    code: varchar("code", { length: 16 }).notNull(),
    name: text("name").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.countryCode, table.code] }),
    foreignKey({
      name: "subdivisions_country_fk",
      columns: [table.countryCode],
      foreignColumns: [countries.code],
    }),
  ],
);

export const addresses = pgTable(
  "addresses",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    line1: varchar("line1", { length: 200 }).notNull(),
    line2: varchar("line2", { length: 200 }),
    city: varchar("city", { length: 120 }).notNull(),
    subdivisionCode: varchar("subdivision_code", { length: 16 }),
    postalCode: varchar("postal_code", { length: 32 }),
    countryCode: varchar("country_code", { length: 2 }).notNull(),
    marketOrPlaza: varchar("market_or_plaza", { length: 200 }),
    lineOrBlock: varchar("line_or_block", { length: 80 }),
    shopNumber: varchar("shop_number", { length: 40 }),
    ...timestamps,
  },
  (table) => [
    index("addresses_tenant_id_idx").on(table.tenantId),
    uniqueIndex("addresses_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "addresses_country_fk",
      columns: [table.countryCode],
      foreignColumns: [countries.code],
    }),
    foreignKey({
      name: "addresses_subdivision_fk",
      columns: [table.countryCode, table.subdivisionCode],
      foreignColumns: [subdivisions.countryCode, subdivisions.code],
    }),
  ],
);

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey(),
    name: varchar("name", { length: 160 }).notNull(),
    slug: varchar("slug", { length: 160 }).notNull().unique(),
    /** The business's own link name (migration 0024, ADR-024): bizora.app/<handle>. */
    handle: varchar("handle", { length: 40 }).notNull().unique(),
    about: varchar("about", { length: 280 }),
    logoUrl: varchar("logo_url", { length: 2048 }),
    primaryColor: varchar("primary_color", { length: 7 }).notNull().default("#1D4ED8"),
    accentColor: varchar("accent_color", { length: 7 }).notNull().default("#0F172A"),
    receiptMessage: varchar("receipt_message", { length: 300 }),
    invoiceMessage: varchar("invoice_message", { length: 500 }),
    documentTerms: varchar("document_terms", { length: 1000 }),
    onboardingCompletedAt: timestamp("onboarding_completed_at", { withTimezone: true }),
    addressId: uuid("address_id"),
    phoneE164: varchar("phone_e164", { length: 20 }),
    traderProfile: jsonb("trader_profile"),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "organizations_address_fk",
      columns: [table.id, table.addressId],
      foreignColumns: [addresses.tenantId, addresses.id],
    }),
  ],
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    // Null only for staff users (kind = 'staff'), who sign in with a PIN on an enrolled shop device.
    email: varchar("email", { length: 320 }).unique(),
    passwordHash: varchar("password_hash", { length: 255 }),
    displayName: varchar("display_name", { length: 120 }).notNull(),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    kind: varchar("kind", { length: 16 }).notNull().default("person"),
    ...timestamps,
  },
  (table) => [
    check("users_kind_ck", sql`${table.kind} IN ('person', 'staff')`),
    check("users_person_email_ck", sql`${table.kind} = 'staff' OR ${table.email} IS NOT NULL`),
    check(
      "users_staff_no_credentials_ck",
      sql`${table.kind} = 'person' OR (${table.email} IS NULL AND ${table.passwordHash} IS NULL)`,
    ),
  ],
);

export const userIdentities = pgTable(
  "user_identities",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull(),
    provider: varchar("provider", { length: 32 }).notNull(),
    providerSubject: varchar("provider_subject", { length: 255 }).notNull(),
    email: varchar("email", { length: 320 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("user_identities_provider_subject_key").on(table.provider, table.providerSubject),
    index("user_identities_user_id_idx").on(table.userId),
  ],
);

export const authTokens = pgTable(
  "auth_tokens",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull(),
    purpose: varchar("purpose", { length: 32 }).notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("auth_tokens_user_purpose_idx").on(table.userId, table.purpose)],
);

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
    addressId: uuid("address_id"),
    phoneE164: varchar("phone_e164", { length: 20 }),
    businessType: varchar("business_type", { length: 64 }),
    otherCurrencies: boolean("other_currencies").notNull().default(false),
    staffCountBand: varchar("staff_count_band", { length: 16 }),
    branchCount: integer("branch_count"),
    whatYouSell: text("what_you_sell"),
    multiCurrencyEnabled: boolean("multi_currency_enabled").notNull().default(false),
    staffFeaturesEnabled: boolean("staff_features_enabled").notNull().default(true),
    salesFlow: varchar("sales_flow", { length: 10 }).notNull().default("simple"),
    visibleModules: text("visible_modules")
      .array()
      .notNull()
      .default(sql`ARRAY['home','sales','stock','customers','debtors','money','staff','reports','settings']::text[]`),
    /** Opening hours per weekday (ADR-034); null means staff can work at any time. */
    openingHours: jsonb("opening_hours").$type<OpeningHours | null>(),
    ...timestamps,
  },
  (table) => [
    index("businesses_tenant_id_idx").on(table.tenantId),
    uniqueIndex("businesses_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "businesses_address_fk",
      columns: [table.tenantId, table.addressId],
      foreignColumns: [addresses.tenantId, addresses.id],
    }),
  ],
);

export const branches = pgTable(
  "branches",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    businessId: uuid("business_id").notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    addressId: uuid("address_id"),
    phoneE164: varchar("phone_e164", { length: 20 }),
    // A closed shop keeps its history (ADR-032).
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by"),
    closedReason: varchar("closed_reason", { length: 240 }),
    movedIntoBranchId: uuid("moved_into_branch_id"),
    // The owner's lock (ADR-034): staff cannot change anything in this shop until it is unlocked.
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: uuid("locked_by"),
    lockNote: varchar("lock_note", { length: 240 }),
    ...timestamps,
  },
  (table) => [
    index("branches_tenant_id_idx").on(table.tenantId),
    index("branches_business_id_idx").on(table.businessId),
    uniqueIndex("branches_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "branches_address_fk",
      columns: [table.tenantId, table.addressId],
      foreignColumns: [addresses.tenantId, addresses.id],
    }),
    foreignKey({
      name: "branches_tenant_business_fk",
      columns: [table.tenantId, table.businessId],
      foreignColumns: [businesses.tenantId, businesses.id],
    }),
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
    /** The shop Bizora opens in for someone who may work in more than one (ADR-032). */
    defaultBranchId: uuid("default_branch_id"),
    status: varchar("status", { length: 24 }).notNull().default("ACTIVE"),
    phoneE164: varchar("phone_e164", { length: 20 }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("memberships_tenant_user_idx").on(table.tenantId, table.userId),
    uniqueIndex("memberships_tenant_id_id_key").on(table.tenantId, table.id),
    index("memberships_user_id_idx").on(table.userId),
    foreignKey({
      name: "memberships_tenant_business_fk",
      columns: [table.tenantId, table.businessId],
      foreignColumns: [businesses.tenantId, businesses.id],
    }),
    foreignKey({
      name: "memberships_tenant_branch_fk",
      columns: [table.tenantId, table.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }),
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
    foreignKey({
      name: "invitations_tenant_business_fk",
      columns: [table.tenantId, table.businessId],
      foreignColumns: [businesses.tenantId, businesses.id],
    }),
    foreignKey({
      name: "invitations_tenant_branch_fk",
      columns: [table.tenantId, table.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }),
  ],
);


export const shopDevices = pgTable(
  "shop_devices",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    businessId: uuid("business_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    name: varchar("name", { length: 80 }).notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    attemptsResetAt: timestamp("attempts_reset_at", { withTimezone: true }),
    /** Short number per organization (DEV3), used in provisional document numbers. */
    code: integer("code").notNull(),
  },
  (table) => [
    uniqueIndex("shop_devices_tenant_id_id_key").on(table.tenantId, table.id),
    uniqueIndex("shop_devices_tenant_code_key").on(table.tenantId, table.code),
    index("shop_devices_tenant_branch_idx").on(table.tenantId, table.branchId),
    foreignKey({
      name: "shop_devices_business_fk",
      columns: [table.tenantId, table.businessId],
      foreignColumns: [businesses.tenantId, businesses.id],
    }),
    foreignKey({
      name: "shop_devices_branch_fk",
      columns: [table.tenantId, table.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }),
  ],
);

export const staffCredentials = pgTable(
  "staff_credentials",
  {
    membershipId: uuid("membership_id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    pinHash: varchar("pin_hash", { length: 255 }).notNull(),
    pinUpdatedAt: timestamp("pin_updated_at", { withTimezone: true }).notNull().defaultNow(),
    attemptsResetAt: timestamp("attempts_reset_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "staff_credentials_membership_fk",
      columns: [table.tenantId, table.membershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
  ],
);

export const staffPinAttempts = pgTable(
  "staff_pin_attempts",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    membershipId: uuid("membership_id"),
    succeeded: boolean("succeeded").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("staff_pin_attempts_device_member_idx").on(table.deviceId, table.membershipId, table.createdAt),
    index("staff_pin_attempts_device_idx").on(table.deviceId, table.createdAt),
    foreignKey({
      name: "staff_pin_attempts_device_fk",
      columns: [table.tenantId, table.deviceId],
      foreignColumns: [shopDevices.tenantId, shopDevices.id],
    }),
    foreignKey({
      name: "staff_pin_attempts_membership_fk",
      columns: [table.tenantId, table.membershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
  ],
);

export const plans = pgTable("plans", {
  code: varchar("code", { length: 32 }).primaryKey(),
  name: varchar("name", { length: 80 }).notNull(),
  limits: jsonb("limits").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const organizationPlans = pgTable("organization_plans", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => organizations.id),
  planCode: varchar("plan_code", { length: 32 })
    .notNull()
    .references(() => plans.code),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull(),
    tenantId: uuid("tenant_id"),
    membershipId: uuid("membership_id"),
    businessId: uuid("business_id"),
    branchId: uuid("branch_id"),
    refreshTokenHash: varchar("refresh_token_hash", { length: 64 }).notNull().unique(),
    familyId: uuid("family_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    replacedBy: uuid("replaced_by"),
    userAgent: varchar("user_agent", { length: 512 }),
    ip: varchar("ip", { length: 64 }),
    deviceId: uuid("device_id"),
  },
  (table) => [
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_family_id_idx").on(table.familyId),
    foreignKey({
      name: "sessions_tenant_business_fk",
      columns: [table.tenantId, table.businessId],
      foreignColumns: [businesses.tenantId, businesses.id],
    }),
    foreignKey({
      name: "sessions_tenant_branch_fk",
      columns: [table.tenantId, table.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }),
    foreignKey({
      name: "sessions_tenant_membership_fk",
      columns: [table.tenantId, table.membershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    foreignKey({
      name: "sessions_tenant_device_fk",
      columns: [table.tenantId, table.deviceId],
      foreignColumns: [shopDevices.tenantId, shopDevices.id],
    }),
    index("sessions_device_id_idx").on(table.deviceId),
    check("sessions_scope_ck", sql`${table.branchId} IS NULL OR ${table.businessId} IS NOT NULL`),
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
    businessId: uuid("business_id"),
    branchId: uuid("branch_id"),
    actorType: varchar("actor_type", { length: 24 }).notNull().default("HUMAN"),
    source: varchar("source", { length: 64 }),
    ip: varchar("ip", { length: 64 }),
    userAgent: varchar("user_agent", { length: 512 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_events_tenant_id_idx").on(table.tenantId),
    index("audit_events_correlation_id_idx").on(table.correlationId),
  ],
);

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    businessId: uuid("business_id").notNull(),
    branchId: uuid("branch_id"),
    name: varchar("name", { length: 160 }).notNull(),
    phoneE164: varchar("phone_e164", { length: 20 }),
    isWalkIn: boolean("is_walk_in").notNull().default(false),
    email: varchar("email", { length: 320 }),
    addressId: uuid("address_id"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    notesSummary: text("notes_summary"),
    creditAllowed: boolean("credit_allowed").notNull().default(false),
    creditLimitMinor: bigint("credit_limit_minor", { mode: "bigint" }),
    creditApprovedBy: uuid("credit_approved_by"),
    creditApprovedAt: timestamp("credit_approved_at", { withTimezone: true }),
    statementToken: varchar("statement_token", { length: 64 }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("customers_tenant_business_idx").on(table.tenantId, table.businessId),
    index("customers_tenant_business_name_idx").on(table.tenantId, table.businessId, table.name),
    uniqueIndex("customers_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "customers_tenant_business_fk",
      columns: [table.tenantId, table.businessId],
      foreignColumns: [businesses.tenantId, businesses.id],
    }),
    foreignKey({
      name: "customers_tenant_branch_fk",
      columns: [table.tenantId, table.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }),
    foreignKey({
      name: "customers_tenant_address_fk",
      columns: [table.tenantId, table.addressId],
      foreignColumns: [addresses.tenantId, addresses.id],
    }),
  ],
);

export const customerNotes = pgTable(
  "customer_notes",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    businessId: uuid("business_id").notNull(),
    customerId: uuid("customer_id").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by"),
  },
  (table) => [
    index("customer_notes_customer_idx").on(table.tenantId, table.customerId, table.createdAt),
    uniqueIndex("customer_notes_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "customer_notes_customer_fk",
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    foreignKey({
      name: "customer_notes_business_fk",
      columns: [table.tenantId, table.businessId],
      foreignColumns: [businesses.tenantId, businesses.id],
    }),
  ],
);

export const customerFollowups = pgTable(
  "customer_followups",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    businessId: uuid("business_id").notNull(),
    customerId: uuid("customer_id").notNull(),
    branchId: uuid("branch_id"),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    assignedTo: uuid("assigned_to"),
    status: varchar("status", { length: 16 }).notNull().default("open"),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("customer_followups_due_idx").on(table.tenantId, table.businessId, table.status, table.dueAt),
    uniqueIndex("customer_followups_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "customer_followups_customer_fk",
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    foreignKey({
      name: "customer_followups_business_fk",
      columns: [table.tenantId, table.businessId],
      foreignColumns: [businesses.tenantId, businesses.id],
    }),
    foreignKey({
      name: "customer_followups_branch_fk",
      columns: [table.tenantId, table.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }),
    foreignKey({
      name: "customer_followups_assignee_fk",
      columns: [table.tenantId, table.assignedTo],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
  ],
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
    key: varchar("key", { length: 64 }).notNull(),
    scope: varchar("scope", { length: 120 }).notNull(),
    requestHash: char("request_hash", { length: 64 }).notNull(),
    membershipId: uuid("membership_id").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("in_progress"),
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.key] }), index("idempotency_keys_created_idx").on(table.createdAt)],
);

export const documentSequences = pgTable(
  "document_sequences",
  {
    tenantId: uuid("tenant_id").notNull(),
    businessId: uuid("business_id").notNull(),
    documentType: varchar("document_type", { length: 32 }).notNull(),
    nextValue: bigint("next_value", { mode: "bigint" }).notNull().default(1n),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.businessId, table.documentType] }),
    foreignKey({
      name: "document_sequences_business_fk",
      columns: [table.tenantId, table.businessId],
      foreignColumns: [businesses.tenantId, businesses.id],
    }),
  ],
);

export const ledgerAccounts = pgTable(
  "ledger_accounts",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    businessId: uuid("business_id").notNull(),
    branchId: uuid("branch_id"),
    code: varchar("code", { length: 20 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    accountType: varchar("account_type", { length: 16 }).notNull(),
    role: varchar("role", { length: 32 }).notNull(),
    isSystem: boolean("is_system").notNull().default(true),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("ledger_accounts_tenant_id_id_key").on(table.tenantId, table.id),
    uniqueIndex("ledger_accounts_tenant_business_id_key").on(table.tenantId, table.businessId, table.id),
    uniqueIndex("ledger_accounts_business_code_key").on(table.tenantId, table.businessId, table.code),
    foreignKey({
      name: "ledger_accounts_business_fk",
      columns: [table.tenantId, table.businessId],
      foreignColumns: [businesses.tenantId, businesses.id],
    }),
    foreignKey({
      name: "ledger_accounts_branch_fk",
      columns: [table.tenantId, table.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }),
  ],
);

export const ledgerPeriods = pgTable(
  "ledger_periods",
  {
    tenantId: uuid("tenant_id").notNull(),
    businessId: uuid("business_id").notNull(),
    periodStart: date("period_start").notNull(),
    status: varchar("status", { length: 8 }).notNull().default("open"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: uuid("locked_by"),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.businessId, table.periodStart] }),
    foreignKey({
      name: "ledger_periods_business_fk",
      columns: [table.tenantId, table.businessId],
      foreignColumns: [businesses.tenantId, businesses.id],
    }),
  ],
);

export const journalEntries = pgTable(
  "journal_entries",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    businessId: uuid("business_id").notNull(),
    branchId: uuid("branch_id"),
    entryDate: date("entry_date").notNull(),
    periodStart: date("period_start").notNull(),
    currencyCode: char("currency_code", { length: 3 }).notNull(),
    sourceType: varchar("source_type", { length: 32 }).notNull(),
    sourceId: uuid("source_id").notNull(),
    postingKey: varchar("posting_key", { length: 160 }).notNull(),
    description: varchar("description", { length: 240 }).notNull(),
    reversesEntryId: uuid("reverses_entry_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by"),
  },
  (table) => [
    uniqueIndex("journal_entries_tenant_id_id_key").on(table.tenantId, table.id),
    uniqueIndex("journal_entries_tenant_business_id_key").on(table.tenantId, table.businessId, table.id),
    uniqueIndex("journal_entries_posting_key").on(table.tenantId, table.postingKey),
    index("journal_entries_source_idx").on(table.tenantId, table.sourceType, table.sourceId),
    foreignKey({
      name: "journal_entries_business_fk",
      columns: [table.tenantId, table.businessId],
      foreignColumns: [businesses.tenantId, businesses.id],
    }),
    foreignKey({
      name: "journal_entries_branch_fk",
      columns: [table.tenantId, table.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }),
    foreignKey({
      name: "journal_entries_period_fk",
      columns: [table.tenantId, table.businessId, table.periodStart],
      foreignColumns: [ledgerPeriods.tenantId, ledgerPeriods.businessId, ledgerPeriods.periodStart],
    }),
  ],
);

export const journalLines = pgTable(
  "journal_lines",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    businessId: uuid("business_id").notNull(),
    entryId: uuid("entry_id").notNull(),
    accountId: uuid("account_id").notNull(),
    lineNo: smallint("line_no").notNull(),
    debitMinor: bigint("debit_minor", { mode: "bigint" }).notNull().default(0n),
    creditMinor: bigint("credit_minor", { mode: "bigint" }).notNull().default(0n),
    originalCurrencyCode: char("original_currency_code", { length: 3 }),
    originalAmountMinor: bigint("original_amount_minor", { mode: "bigint" }),
    fxRate: numeric("fx_rate", { precision: 24, scale: 10 }),
    memo: varchar("memo", { length: 240 }),
  },
  (table) => [
    uniqueIndex("journal_lines_entry_line_key").on(table.entryId, table.lineNo),
    index("journal_lines_account_idx").on(table.tenantId, table.accountId),
    foreignKey({
      name: "journal_lines_entry_fk",
      columns: [table.tenantId, table.businessId, table.entryId],
      foreignColumns: [journalEntries.tenantId, journalEntries.businessId, journalEntries.id],
    }),
    foreignKey({
      name: "journal_lines_account_fk",
      columns: [table.tenantId, table.businessId, table.accountId],
      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.businessId, ledgerAccounts.id],
    }),
  ],
);

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    businessId: uuid("business_id").notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    category: varchar("category", { length: 60 }),
    baseUnit: varchar("base_unit", { length: 16 }).notNull(),
    priceMinor: bigint("price_minor", { mode: "bigint" }),
    defaultCostMinor: bigint("default_cost_minor", { mode: "bigint" }),
    lowStockLevel: bigint("low_stock_level", { mode: "bigint" }),
    barcode: varchar("barcode", { length: 64 }),
    trackStock: boolean("track_stock").notNull().default(true),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("products_tenant_id_id_key").on(table.tenantId, table.id),
    uniqueIndex("products_tenant_business_id_key").on(table.tenantId, table.businessId, table.id),
    index("products_business_updated_idx").on(table.tenantId, table.businessId, table.updatedAt, table.id),
    foreignKey({
      name: "products_business_fk",
      columns: [table.tenantId, table.businessId],
      foreignColumns: [businesses.tenantId, businesses.id],
    }),
  ],
);

export const productUnits = pgTable(
  "product_units",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    businessId: uuid("business_id").notNull(),
    productId: uuid("product_id").notNull(),
    unitCode: varchar("unit_code", { length: 16 }).notNull(),
    baseQuantity: bigint("base_quantity", { mode: "bigint" }).notNull(),
    priceMinor: bigint("price_minor", { mode: "bigint" }),
  },
  (table) => [
    uniqueIndex("product_units_product_unit_key").on(table.productId, table.unitCode),
    foreignKey({
      name: "product_units_product_fk",
      columns: [table.tenantId, table.businessId, table.productId],
      foreignColumns: [products.tenantId, products.businessId, products.id],
    }),
  ],
);

export const stockMovements = pgTable(
  "stock_movements",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    businessId: uuid("business_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    productId: uuid("product_id").notNull(),
    movementType: varchar("movement_type", { length: 16 }).notNull(),
    quantity: bigint("quantity", { mode: "bigint" }).notNull(),
    valueMinor: bigint("value_minor", { mode: "bigint" }).notNull(),
    enteredQuantity: bigint("entered_quantity", { mode: "bigint" }).notNull(),
    enteredUnit: varchar("entered_unit", { length: 16 }).notNull(),
    reason: varchar("reason", { length: 32 }),
    note: varchar("note", { length: 240 }),
    supplier: varchar("supplier", { length: 160 }),
    supplierId: uuid("supplier_id"),
    paidFrom: varchar("paid_from", { length: 8 }),
    documentNumber: varchar("document_number", { length: 24 }),
    transferId: uuid("transfer_id"),
    countId: uuid("count_id"),
    journalEntryId: uuid("journal_entry_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by"),
    membershipId: uuid("membership_id"),
    deviceId: uuid("device_id"),
    actorType: varchar("actor_type", { length: 16 }).notNull().default("HUMAN"),
  },
  (table) => [
    uniqueIndex("stock_movements_tenant_id_id_key").on(table.tenantId, table.id),
    index("stock_movements_product_idx").on(table.tenantId, table.productId, table.createdAt),
    index("stock_movements_branch_idx").on(table.tenantId, table.branchId, table.createdAt),
    foreignKey({
      name: "stock_movements_business_fk",
      columns: [table.tenantId, table.businessId],
      foreignColumns: [businesses.tenantId, businesses.id],
    }),
    foreignKey({
      name: "stock_movements_branch_fk",
      columns: [table.tenantId, table.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }),
    foreignKey({
      name: "stock_movements_product_fk",
      columns: [table.tenantId, table.businessId, table.productId],
      foreignColumns: [products.tenantId, products.businessId, products.id],
    }),
  ],
);

export const stockBalances = pgTable(
  "stock_balances",
  {
    tenantId: uuid("tenant_id").notNull(),
    businessId: uuid("business_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    productId: uuid("product_id").notNull(),
    quantity: bigint("quantity", { mode: "bigint" }).notNull().default(0n),
    valueMinor: bigint("value_minor", { mode: "bigint" }).notNull().default(0n),
    negativeSince: timestamp("negative_since", { withTimezone: true }),
    lastMovementAt: timestamp("last_movement_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.branchId, table.productId] }),
    index("stock_balances_business_updated_idx").on(table.tenantId, table.businessId, table.updatedAt),
    foreignKey({
      name: "stock_balances_branch_fk",
      columns: [table.tenantId, table.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }),
    foreignKey({
      name: "stock_balances_product_fk",
      columns: [table.tenantId, table.businessId, table.productId],
      foreignColumns: [products.tenantId, products.businessId, products.id],
    }),
  ],
);

export const stockCounts = pgTable(
  "stock_counts",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    businessId: uuid("business_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    productId: uuid("product_id").notNull(),
    countedQuantity: bigint("counted_quantity", { mode: "bigint" }).notNull(),
    systemQuantity: bigint("system_quantity", { mode: "bigint" }).notNull(),
    difference: bigint("difference", { mode: "bigint" }).notNull(),
    status: varchar("status", { length: 10 }).notNull().default("pending"),
    note: varchar("note", { length: 240 }),
    decisionNote: varchar("decision_note", { length: 240 }),
    countedBy: uuid("counted_by"),
    countedMembershipId: uuid("counted_membership_id"),
    deviceId: uuid("device_id"),
    countedAt: timestamp("counted_at", { withTimezone: true }).notNull(),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    movementId: uuid("movement_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("stock_counts_branch_status_idx").on(table.tenantId, table.branchId, table.status, table.countedAt),
    foreignKey({
      name: "stock_counts_branch_fk",
      columns: [table.tenantId, table.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }),
    foreignKey({
      name: "stock_counts_product_fk",
      columns: [table.tenantId, table.businessId, table.productId],
      foreignColumns: [products.tenantId, products.businessId, products.id],
    }),
  ],
);

export const sales = pgTable(
  "sales",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    businessId: uuid("business_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    customerId: uuid("customer_id"),
    saleNumber: varchar("sale_number", { length: 24 }),
    provisionalNumber: varchar("provisional_number", { length: 24 }),
    externalRef: varchar("external_ref", { length: 64 }),
    status: varchar("status", { length: 20 }).notNull().default("completed"),
    historyOnly: boolean("history_only").notNull().default(false),
    source: varchar("source", { length: 10 }).notNull().default("pos"),
    currencyCode: char("currency_code", { length: 3 }).notNull(),
    subtotalMinor: bigint("subtotal_minor", { mode: "bigint" }).notNull(),
    discountMinor: bigint("discount_minor", { mode: "bigint" }).notNull().default(0n),
    totalMinor: bigint("total_minor", { mode: "bigint" }).notNull(),
    paidMinor: bigint("paid_minor", { mode: "bigint" }).notNull(),
    balanceMinor: bigint("balance_minor", { mode: "bigint" }).notNull(),
    returnedMinor: bigint("returned_minor", { mode: "bigint" }).notNull().default(0n),
    returnedOffBalanceMinor: bigint("returned_off_balance_minor", { mode: "bigint" }).notNull().default(0n),
    note: varchar("note", { length: 240 }),
    receiptToken: varchar("receipt_token", { length: 64 }).notNull(),
    journalEntryId: uuid("journal_entry_id"),
    soldAt: timestamp("sold_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by"),
    membershipId: uuid("membership_id"),
    deviceId: uuid("device_id"),
    actorType: varchar("actor_type", { length: 16 }).notNull().default("HUMAN"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by"),
    voidReason: varchar("void_reason", { length: 240 }),
    invoiceNumber: varchar("invoice_number", { length: 20 }),
    requestedPayment: varchar("requested_payment", { length: 10 }),
    dueDate: date("due_date", { mode: "string" }),
    collectedAt: timestamp("collected_at", { withTimezone: true }),
    collectedBy: uuid("collected_by"),
    collectedMembershipId: uuid("collected_membership_id"),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releasedBy: uuid("released_by"),
    releasedMembershipId: uuid("released_membership_id"),
  },
  (table) => [
    uniqueIndex("sales_tenant_id_id_key").on(table.tenantId, table.id),
    uniqueIndex("sales_tenant_business_id_key").on(table.tenantId, table.businessId, table.id),
    index("sales_branch_sold_idx").on(table.tenantId, table.branchId, table.soldAt),
    foreignKey({ name: "sales_business_fk", columns: [table.tenantId, table.businessId], foreignColumns: [businesses.tenantId, businesses.id] }),
    foreignKey({ name: "sales_branch_fk", columns: [table.tenantId, table.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ name: "sales_customer_fk", columns: [table.tenantId, table.customerId], foreignColumns: [customers.tenantId, customers.id] }),
  ],
);

export const saleLines = pgTable(
  "sale_lines",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    businessId: uuid("business_id").notNull(),
    saleId: uuid("sale_id").notNull(),
    lineNo: smallint("line_no").notNull(),
    productId: uuid("product_id"),
    description: varchar("description", { length: 160 }).notNull(),
    quantity: bigint("quantity", { mode: "bigint" }).notNull(),
    enteredQuantity: bigint("entered_quantity", { mode: "bigint" }).notNull(),
    enteredUnit: varchar("entered_unit", { length: 16 }).notNull(),
    unitPriceMinor: bigint("unit_price_minor", { mode: "bigint" }).notNull(),
    discountMinor: bigint("discount_minor", { mode: "bigint" }).notNull().default(0n),
    lineTotalMinor: bigint("line_total_minor", { mode: "bigint" }).notNull(),
    costMinor: bigint("cost_minor", { mode: "bigint" }),
    stockMovementId: uuid("stock_movement_id"),
  },
  (table) => [
    uniqueIndex("sale_lines_sale_line_key").on(table.saleId, table.lineNo),
    foreignKey({ name: "sale_lines_sale_fk", columns: [table.tenantId, table.businessId, table.saleId], foreignColumns: [sales.tenantId, sales.businessId, sales.id] }),
    foreignKey({ name: "sale_lines_product_fk", columns: [table.tenantId, table.businessId, table.productId], foreignColumns: [products.tenantId, products.businessId, products.id] }),
  ],
);

export const salePayments = pgTable(
  "sale_payments",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    businessId: uuid("business_id").notNull(),
    saleId: uuid("sale_id").notNull(),
    method: varchar("method", { length: 10 }).notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    reference: varchar("reference", { length: 64 }),
    // Transfers wait for someone who can see the bank (ADR-031).
    confirmation: varchar("confirmation", { length: 12 }).notNull().default("confirmed"),
    confirmedVia: varchar("confirmed_via", { length: 16 }),
    confirmedBy: uuid("confirmed_by"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    confirmationEntryId: uuid("confirmation_entry_id"),
    notReceivedAs: varchar("not_received_as", { length: 8 }),
    confirmationNote: varchar("confirmation_note", { length: 240 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("sale_payments_sale_idx").on(table.tenantId, table.saleId),
    foreignKey({ name: "sale_payments_sale_fk", columns: [table.tenantId, table.businessId, table.saleId], foreignColumns: [sales.tenantId, sales.businessId, sales.id] }),
  ],
);

export const customerPayments = pgTable(
  "customer_payments",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    businessId: uuid("business_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    customerId: uuid("customer_id").notNull(),
    paymentNumber: varchar("payment_number", { length: 20 }).notNull(),
    method: varchar("method", { length: 10 }).notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currencyCode: char("currency_code", { length: 3 }).notNull(),
    reference: varchar("reference", { length: 80 }),
    note: varchar("note", { length: 240 }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    status: varchar("status", { length: 10 }).notNull().default("recorded"),
    // Transfers wait for someone who can see the bank (ADR-031).
    confirmation: varchar("confirmation", { length: 12 }).notNull().default("confirmed"),
    confirmedVia: varchar("confirmed_via", { length: 16 }),
    confirmedBy: uuid("confirmed_by"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    confirmationEntryId: uuid("confirmation_entry_id"),
    confirmationNote: varchar("confirmation_note", { length: 240 }),
    journalEntryId: uuid("journal_entry_id"),
    receiptToken: varchar("receipt_token", { length: 64 }).notNull(),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by"),
    voidReason: varchar("void_reason", { length: 240 }),
    /** A deposit taken on a job before it was finished (ADR-035). */
    jobId: uuid("job_id"),
    createdBy: uuid("created_by").notNull(),
    membershipId: uuid("membership_id"),
    deviceId: uuid("device_id"),
    actorType: varchar("actor_type", { length: 20 }).notNull().default("HUMAN"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("customer_payments_tenant_id_id_key").on(table.tenantId, table.id),
    uniqueIndex("customer_payments_number_key").on(table.tenantId, table.businessId, table.paymentNumber),
    uniqueIndex("customer_payments_receipt_token_key").on(table.receiptToken),
    index("customer_payments_customer_idx").on(table.tenantId, table.customerId, table.receivedAt),
    foreignKey({ name: "customer_payments_customer_fk", columns: [table.tenantId, table.customerId], foreignColumns: [customers.tenantId, customers.id] }),
    foreignKey({ name: "customer_payments_branch_fk", columns: [table.tenantId, table.branchId], foreignColumns: [branches.tenantId, branches.id] }),
  ],
);

export const paymentAllocations = pgTable(
  "payment_allocations",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    paymentId: uuid("payment_id").notNull(),
    saleId: uuid("sale_id").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("payment_allocations_sale_idx").on(table.tenantId, table.saleId),
    index("payment_allocations_payment_idx").on(table.tenantId, table.paymentId),
    foreignKey({ name: "payment_allocations_payment_fk", columns: [table.tenantId, table.paymentId], foreignColumns: [customerPayments.tenantId, customerPayments.id] }),
    foreignKey({ name: "payment_allocations_sale_fk", columns: [table.tenantId, table.saleId], foreignColumns: [sales.tenantId, sales.id] }),
  ],
);

export const statementImports = pgTable(
  "statement_imports",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    businessId: uuid("business_id").notNull(),
    accountLabel: varchar("account_label", { length: 80 }).notNull(),
    source: varchar("source", { length: 10 }).notNull().default("file"),
    linesNew: integer("lines_new").notNull().default(0),
    linesDuplicate: integer("lines_duplicate").notNull().default(0),
    linesOutSkipped: integer("lines_out_skipped").notNull().default(0),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("statement_imports_tenant_id_id_key").on(table.tenantId, table.id)],
);

export const statementRules = pgTable(
  "statement_rules",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    businessId: uuid("business_id").notNull(),
    pattern: varchar("pattern", { length: 80 }).notNull(),
    target: jsonb("target").$type<Record<string, unknown>>().notNull(),
    timesUsed: integer("times_used").notNull().default(0),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("statement_rules_tenant_id_id_key").on(table.tenantId, table.id), uniqueIndex("statement_rules_pattern_key").on(table.tenantId, table.businessId, table.pattern)],
);

export const statementLines = pgTable(
  "statement_lines",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    businessId: uuid("business_id").notNull(),
    importId: uuid("import_id").notNull(),
    accountLabel: varchar("account_label", { length: 80 }).notNull(),
    txnDate: date("txn_date", { mode: "string" }).notNull(),
    description: varchar("description", { length: 300 }).notNull().default(""),
    reference: varchar("reference", { length: 120 }),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currencyCode: char("currency_code", { length: 3 }).notNull(),
    fingerprint: varchar("fingerprint", { length: 64 }).notNull(),
    status: varchar("status", { length: 10 }).notNull().default("open"),
    matchKind: varchar("match_kind", { length: 20 }),
    matchDetail: varchar("match_detail", { length: 40 }),
    salePaymentId: uuid("sale_payment_id"),
    customerPaymentId: uuid("customer_payment_id"),
    createdPayment: boolean("created_payment").notNull().default(false),
    customerId: uuid("customer_id"),
    journalEntryId: uuid("journal_entry_id"),
    ruleId: uuid("rule_id"),
    autoMatched: boolean("auto_matched").notNull().default(false),
    note: varchar("note", { length: 200 }),
    matchedBy: uuid("matched_by"),
    matchedAt: timestamp("matched_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("statement_lines_fingerprint_key").on(table.tenantId, table.businessId, table.fingerprint),
    index("statement_lines_inbox_idx").on(table.tenantId, table.businessId, table.status, table.txnDate),
    foreignKey({ name: "statement_lines_import_fk", columns: [table.tenantId, table.importId], foreignColumns: [statementImports.tenantId, statementImports.id] }),
  ],
);

export const saleComments = pgTable(
  "sale_comments",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    businessId: uuid("business_id").notNull(),
    saleId: uuid("sale_id").notNull(),
    userId: uuid("user_id"),
    membershipId: uuid("membership_id"),
    role: varchar("role", { length: 24 }),
    kind: varchar("kind", { length: 12 }).notNull().default("comment"),
    body: varchar("body", { length: 500 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("sale_comments_sale_idx").on(table.tenantId, table.saleId, table.createdAt),
    foreignKey({ name: "sale_comments_sale_fk", columns: [table.tenantId, table.businessId, table.saleId], foreignColumns: [sales.tenantId, sales.businessId, sales.id] }),
  ],
);

export const aiUsage = pgTable(
  "ai_usage",
  {
    tenantId: uuid("tenant_id").notNull(),
    /** Reads are counted per shop (ADR-033). */
    branchId: uuid("branch_id").notNull(),
    day: date("day", { mode: "string" }).notNull(),
    captures: integer("captures").notNull().default(0),
    inputBytes: bigint("input_bytes", { mode: "bigint" }).notNull().default(0n),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.branchId, table.day] })],
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    membershipId: uuid("membership_id").notNull(),
    kind: varchar("kind", { length: 32 }).notNull(),
    saleId: uuid("sale_id"),
    actorName: varchar("actor_name", { length: 160 }),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("notifications_inbox_idx").on(table.tenantId, table.membershipId, table.createdAt),
    foreignKey({ name: "notifications_membership_fk", columns: [table.tenantId, table.membershipId], foreignColumns: [memberships.tenantId, memberships.id] }),
    foreignKey({ name: "notifications_sale_fk", columns: [table.tenantId, table.saleId], foreignColumns: [sales.tenantId, sales.id] }),
  ],
);

/** Binary column: postgres.js returns a Buffer, PGlite a Uint8Array; both become a Buffer. */
const bytea = customType<{ data: Buffer; driverData: Buffer | Uint8Array }>({
  dataType: () => "bytea",
  toDriver: (value) => value,
  fromDriver: (value) => Buffer.from(value),
});

/** Up to 5 photos a product (migration 0031, ADR-033), shown in the order of `position`, 0 first. */
export const productPhotos = pgTable(
  "product_photos",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    businessId: uuid("business_id").notNull(),
    productId: uuid("product_id").notNull(),
    position: smallint("position").notNull(),
    contentType: varchar("content_type", { length: 20 }).notNull(),
    data: bytea("data").notNull(),
    byteSize: integer("byte_size").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    sha256: char("sha256", { length: 64 }).notNull(),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("product_photos_product_idx").on(table.tenantId, table.productId, table.position)],
);

/** The company logo (migration 0022, ADR-021). One per organization. */
export const organizationLogos = pgTable("organization_logos", {
  tenantId: uuid("tenant_id").primaryKey(),
  contentType: varchar("content_type", { length: 20 }).notNull(),
  data: bytea("data").notNull(),
  byteSize: integer("byte_size").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  sha256: char("sha256", { length: 64 }).notNull(),
  updatedBy: uuid("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const schema = {
  addresses,
  organizations,
  users,
  businesses,
  branches,
  countries,
  subdivisions,
  memberships,
  permissions,
  rolePermissions,
  countryPacks,
  industryPacks,
  invitations,
  sessions,
  auditEvents,
  userIdentities,
  authTokens,
  customers,
  customerNotes,
  customerFollowups,
  shopDevices,
  staffCredentials,
  staffPinAttempts,
  plans,
  organizationPlans,
  idempotencyKeys,
  documentSequences,
  ledgerAccounts,
  ledgerPeriods,
  journalEntries,
  journalLines,
  products,
  productUnits,
  stockMovements,
  stockBalances,
  stockCounts,
  sales,
  saleLines,
  salePayments,
  saleComments,
  notifications,
  aiUsage,
  customerPayments,
  paymentAllocations,
  statementImports,
  statementRules,
  statementLines,
  organizationLogos,
};

export type DatabaseSchema = typeof schema;

/** Sprint 7b (ADR-028): what was paid for running the business. */
export const expenses = pgTable(
  "expenses",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    businessId: uuid("business_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    accountId: uuid("account_id").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currencyCode: char("currency_code", { length: 3 }).notNull(),
    paidFrom: varchar("paid_from", { length: 10 }).notNull(),
    expenseDate: date("expense_date").notNull(),
    payee: varchar("payee", { length: 120 }),
    note: varchar("note", { length: 240 }),
    status: varchar("status", { length: 20 }).notNull(),
    journalEntryId: uuid("journal_entry_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by"),
    voidReason: varchar("void_reason", { length: 240 }),
    createdBy: uuid("created_by").notNull(),
    membershipId: uuid("membership_id"),
    deviceId: uuid("device_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("expenses_tenant_id_id_key").on(table.tenantId, table.id),
    index("expenses_day_idx").on(table.tenantId, table.businessId, table.expenseDate),
    foreignKey({ name: "expenses_business_fk", columns: [table.tenantId, table.businessId], foreignColumns: [businesses.tenantId, businesses.id] }),
    foreignKey({ name: "expenses_branch_fk", columns: [table.tenantId, table.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({
      name: "expenses_account_fk",
      columns: [table.tenantId, table.businessId, table.accountId],
      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.businessId, ledgerAccounts.id],
    }),
  ],
);

/** Sprint 7b: the owner's money in and out, and cash moved between a drawer and the bank. */
export const moneyMovements = pgTable(
  "money_movements",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    businessId: uuid("business_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    kind: varchar("kind", { length: 16 }).notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currencyCode: char("currency_code", { length: 3 }).notNull(),
    movementDate: date("movement_date").notNull(),
    note: varchar("note", { length: 240 }),
    status: varchar("status", { length: 10 }).notNull().default("recorded"),
    journalEntryId: uuid("journal_entry_id"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by"),
    voidReason: varchar("void_reason", { length: 240 }),
    createdBy: uuid("created_by").notNull(),
    membershipId: uuid("membership_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("money_movements_tenant_id_id_key").on(table.tenantId, table.id),
    index("money_movements_day_idx").on(table.tenantId, table.businessId, table.movementDate),
    foreignKey({ name: "money_movements_business_fk", columns: [table.tenantId, table.businessId], foreignColumns: [businesses.tenantId, businesses.id] }),
    foreignKey({ name: "money_movements_branch_fk", columns: [table.tenantId, table.branchId], foreignColumns: [branches.tenantId, branches.id] }),
  ],
);

/** Sprint 7b: a count of a shop's drawer; the difference from what was expected is posted. */
export const cashCounts = pgTable(
  "cash_counts",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    businessId: uuid("business_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    countDate: date("count_date").notNull(),
    expectedMinor: bigint("expected_minor", { mode: "bigint" }).notNull(),
    countedMinor: bigint("counted_minor", { mode: "bigint" }).notNull(),
    differenceMinor: bigint("difference_minor", { mode: "bigint" }).notNull(),
    currencyCode: char("currency_code", { length: 3 }).notNull(),
    note: varchar("note", { length: 240 }),
    journalEntryId: uuid("journal_entry_id"),
    createdBy: uuid("created_by").notNull(),
    membershipId: uuid("membership_id"),
    deviceId: uuid("device_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("cash_counts_tenant_id_id_key").on(table.tenantId, table.id),
    index("cash_counts_branch_idx").on(table.tenantId, table.branchId, table.createdAt),
    foreignKey({ name: "cash_counts_business_fk", columns: [table.tenantId, table.businessId], foreignColumns: [businesses.tenantId, businesses.id] }),
    foreignKey({ name: "cash_counts_branch_fk", columns: [table.tenantId, table.branchId], foreignColumns: [branches.tenantId, branches.id] }),
  ],
);

/** Sprint 7c (ADR-029): who the business buys from. */
export const suppliers = pgTable(
  "suppliers",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    businessId: uuid("business_id").notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    phoneE164: varchar("phone_e164", { length: 20 }),
    notes: varchar("notes", { length: 240 }),
    unnamed: boolean("unnamed").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("suppliers_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({ name: "suppliers_business_fk", columns: [table.tenantId, table.businessId], foreignColumns: [businesses.tenantId, businesses.id] }),
  ],
);

/** Sprint 7c: what a supplier is owed, line by line. */
export const supplierEntries = pgTable(
  "supplier_entries",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    businessId: uuid("business_id").notNull(),
    supplierId: uuid("supplier_id").notNull(),
    branchId: uuid("branch_id"),
    kind: varchar("kind", { length: 10 }).notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currencyCode: char("currency_code", { length: 3 }).notNull(),
    entryDate: date("entry_date").notNull(),
    payBy: date("pay_by"),
    paidFrom: varchar("paid_from", { length: 10 }),
    stockMovementId: uuid("stock_movement_id"),
    note: varchar("note", { length: 240 }),
    status: varchar("status", { length: 10 }).notNull().default("recorded"),
    journalEntryId: uuid("journal_entry_id"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by"),
    voidReason: varchar("void_reason", { length: 240 }),
    createdBy: uuid("created_by"),
    membershipId: uuid("membership_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("supplier_entries_tenant_id_id_key").on(table.tenantId, table.id),
    index("supplier_entries_supplier_idx").on(table.tenantId, table.supplierId, table.entryDate),
    foreignKey({ name: "supplier_entries_business_fk", columns: [table.tenantId, table.businessId], foreignColumns: [businesses.tenantId, businesses.id] }),
    foreignKey({ name: "supplier_entries_supplier_fk", columns: [table.tenantId, table.supplierId], foreignColumns: [suppliers.tenantId, suppliers.id] }),
  ],
);

/** Sprint 7d (ADR-030): goods a customer brought back from a sale. Append-only. */
export const saleReturns = pgTable(
  "sale_returns",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    businessId: uuid("business_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    saleId: uuid("sale_id").notNull(),
    customerId: uuid("customer_id"),
    returnNumber: varchar("return_number", { length: 24 }).notNull(),
    totalMinor: bigint("total_minor", { mode: "bigint" }).notNull(),
    offBalanceMinor: bigint("off_balance_minor", { mode: "bigint" }).notNull().default(0n),
    refundMinor: bigint("refund_minor", { mode: "bigint" }).notNull().default(0n),
    refundMethod: varchar("refund_method", { length: 10 }),
    currencyCode: char("currency_code", { length: 3 }).notNull(),
    reason: varchar("reason", { length: 240 }).notNull(),
    journalEntryId: uuid("journal_entry_id"),
    createdBy: uuid("created_by").notNull(),
    membershipId: uuid("membership_id"),
    deviceId: uuid("device_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("sale_returns_tenant_id_id_key").on(table.tenantId, table.id),
    index("sale_returns_sale_idx").on(table.tenantId, table.saleId),
    foreignKey({ name: "sale_returns_business_fk", columns: [table.tenantId, table.businessId], foreignColumns: [businesses.tenantId, businesses.id] }),
    foreignKey({ name: "sale_returns_branch_fk", columns: [table.tenantId, table.branchId], foreignColumns: [branches.tenantId, branches.id] }),
  ],
);

export const saleReturnLines = pgTable(
  "sale_return_lines",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    returnId: uuid("return_id").notNull(),
    saleLineId: uuid("sale_line_id").notNull(),
    quantity: bigint("quantity", { mode: "bigint" }).notNull(),
    enteredQuantity: bigint("entered_quantity", { mode: "bigint" }).notNull(),
    enteredUnit: varchar("entered_unit", { length: 16 }).notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    costMinor: bigint("cost_minor", { mode: "bigint" }).notNull().default(0n),
    backToStock: boolean("back_to_stock").notNull(),
    stockMovementId: uuid("stock_movement_id"),
  },
  (table) => [
    index("sale_return_lines_line_idx").on(table.tenantId, table.saleLineId),
    foreignKey({ name: "sale_return_lines_return_fk", columns: [table.tenantId, table.returnId], foreignColumns: [saleReturns.tenantId, saleReturns.id] }),
  ],
);

/** Owner's permission for one person to work outside the opening hours until a set time (ADR-034). */
export const workPermits = pgTable(
  "work_permits",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    businessId: uuid("business_id").notNull(),
    membershipId: uuid("membership_id").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    note: varchar("note", { length: 240 }),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by"),
  },
  (table) => [index("work_permits_membership_idx").on(table.tenantId, table.membershipId, table.endsAt)],
);

/** A store keeper's stock change waiting for a manager or owner to approve and complete it (ADR-034). */
export const stockRequests = pgTable(
  "stock_requests",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    businessId: uuid("business_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    productId: uuid("product_id").notNull(),
    kind: varchar("kind", { length: 16 }).$type<"receive" | "adjust" | "transfer" | "supplier_return">().notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    summary: varchar("summary", { length: 400 }).notNull(),
    status: varchar("status", { length: 16 }).$type<"pending" | "approved" | "rejected">().notNull().default("pending"),
    requestedBy: uuid("requested_by").notNull(),
    requestedMembershipId: uuid("requested_membership_id").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: varchar("decision_note", { length: 240 }),
    resultMovementId: uuid("result_movement_id"),
  },
  (table) => [index("stock_requests_status_idx").on(table.tenantId, table.businessId, table.status, table.requestedAt)],
);

/** A job for a customer (job card, repair order, tailoring order) (ADR-035). */
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    businessId: uuid("business_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    customerId: uuid("customer_id").notNull(),
    jobNumber: varchar("job_number", { length: 20 }).notNull(),
    title: varchar("title", { length: 160 }),
    problem: varchar("problem", { length: 1000 }),
    summary: varchar("summary", { length: 600 }),
    status: varchar("status", { length: 12 }).$type<"open" | "done" | "cancelled">().notNull().default("open"),
    openedOn: date("opened_on", { mode: "string" }).notNull(),
    promisedOn: date("promised_on", { mode: "string" }),
    saleId: uuid("sale_id"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    finishedBy: uuid("finished_by"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: uuid("cancelled_by"),
    cancelReason: varchar("cancel_reason", { length: 240 }),
    createdBy: uuid("created_by").notNull(),
    membershipId: uuid("membership_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("jobs_tenant_id_id_key").on(table.tenantId, table.id),
    index("jobs_status_idx").on(table.tenantId, table.businessId, table.status, table.openedOn),
    index("jobs_customer_idx").on(table.tenantId, table.customerId, table.openedOn),
  ],
);

export const jobLines = pgTable(
  "job_lines",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    businessId: uuid("business_id").notNull(),
    jobId: uuid("job_id").notNull(),
    lineNo: smallint("line_no").notNull(),
    kind: varchar("kind", { length: 8 }).$type<"work" | "part" | "bought" | "helper">().notNull(),
    description: varchar("description", { length: 160 }).notNull(),
    productId: uuid("product_id"),
    quantity: bigint("quantity", { mode: "bigint" }).notNull(),
    enteredQuantity: bigint("entered_quantity", { mode: "bigint" }).notNull(),
    enteredUnit: varchar("entered_unit", { length: 16 }).notNull(),
    unitPriceMinor: bigint("unit_price_minor", { mode: "bigint" }).notNull().default(0n),
    lineTotalMinor: bigint("line_total_minor", { mode: "bigint" }).notNull().default(0n),
    costMinor: bigint("cost_minor", { mode: "bigint" }).notNull().default(0n),
    paidFrom: varchar("paid_from", { length: 8 }).$type<"cash" | "bank" | "owed" | null>(),
    supplier: varchar("supplier", { length: 160 }),
    stockMovementId: uuid("stock_movement_id"),
    receivedMovementId: uuid("received_movement_id"),
    journalEntryId: uuid("journal_entry_id"),
    usedOn: date("used_on", { mode: "string" }).notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    removedBy: uuid("removed_by"),
    removeReason: varchar("remove_reason", { length: 240 }),
  },
  (table) => [uniqueIndex("job_lines_line_key").on(table.jobId, table.lineNo)],
);

/** Bizora staff who use the Admin portal (ADR-037); not business users. */
export const adminStaff = pgTable("admin_staff", {
  id: uuid("id").primaryKey(),
  email: varchar("email", { length: 320 }).notNull(),
  name: varchar("name", { length: 160 }).notNull(),
  roles: text("roles").array().notNull().default(sql`'{}'::text[]`),
  status: varchar("status", { length: 12 }).$type<"active" | "removed">().notNull().default("active"),
  googleSubject: varchar("google_subject", { length: 255 }),
  lastSignInAt: timestamp("last_sign_in_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by"),
  removedAt: timestamp("removed_at", { withTimezone: true }),
  removedBy: uuid("removed_by"),
});

export const adminSessions = pgTable("admin_sessions", {
  id: uuid("id").primaryKey(),
  staffId: uuid("staff_id").notNull(),
  tokenHash: char("token_hash", { length: 64 }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  ip: varchar("ip", { length: 64 }),
  userAgent: varchar("user_agent", { length: 512 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const adminAudit = pgTable("admin_audit", {
  id: uuid("id").primaryKey(),
  staffId: uuid("staff_id"),
  staffEmail: varchar("staff_email", { length: 320 }).notNull(),
  action: varchar("action", { length: 64 }).notNull(),
  targetType: varchar("target_type", { length: 32 }),
  targetId: uuid("target_id"),
  tenantId: uuid("tenant_id"),
  reason: varchar("reason", { length: 500 }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  ip: varchar("ip", { length: 64 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
