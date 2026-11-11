# ADR-002: PostgreSQL row-level security

## Status

Accepted for Sprint 2.5. RLS is **planned**, not enabled.

## Context

Bizora already enforces tenancy in the API: JWT + session validation, TenantGuard, membership-scoped queries, and `tenant_id` predicates on writes. Payments and financial ledgers need a defense-in-depth layer that still holds if application code misses a filter.

## Decision

Do not enable PostgreSQL RLS in Sprint 2.5. Introducing policies now would risk locking out migrations, seeds, and PGlite tests before every table has a stable `tenant_id` and session GUC story.

Before payments/financial production traffic, introduce:

1. `SET LOCAL bizora.tenant_id = '<uuid>'` (or equivalent) per request transaction.
2. `FORCE ROW LEVEL SECURITY` on tenant-owned tables.
3. Policies of the form `tenant_id = current_setting('bizora.tenant_id')::uuid`.
4. A migration/admin role that bypasses RLS for `schema_migrations` only.

Target defense model:

API authentication → TenantGuard → tenant-scoped repositories → relational constraints → PostgreSQL RLS.

## Consequences

- Application filters remain the current enforcement mechanism.
- Financial modules must not ship to production without this ADR being implemented.
- PGlite tests will need a PostgreSQL-compatible policy strategy or a dedicated RLS CI job against Cloud SQL/Postgres.
