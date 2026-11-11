# Bizora architecture overview

Bizora is a multi-tenant SaaS modular monolith. Sprint 1–2.5 deliver the engineering spine, onboarding, RBAC, and tenancy hardening — not CRM, sales, payments, inventory, or AI.

## Runtime

- `apps/web` — Next.js responsive PWA. Browser calls `/api/v1/*`, rewritten to the NestJS API so session cookies stay first-party.
- `apps/api` — NestJS modular monolith. Identity, tenant, RBAC, audit and health live here. CRM, sales, payments, inventory and AI remain reserved module folders.
- `apps/worker` — Process placeholder for later jobs (BullMQ / Pub/Sub).
- PostgreSQL is the system of record. Redis is provisioned locally for later queues.
- Google Cloud Run + Cloud SQL is the target runtime. Secrets belong in Secret Manager.

## Tenancy

Organization is the security and billing tenant. A tenant owns businesses; businesses own branches. Every tenant-owned row stores `tenant_id`. Request tenant context is loaded from the verified session (`bid` / `br` claims persisted on the `sessions` row) and re-checked against the authenticated **ACTIVE** membership. Client `X-Tenant-Id`, `X-Organization-Id`, `X-Business-Id`, and `X-Branch-Id` headers are ignored. Change active business or branch only with `POST /api/v1/auth/select-context`.

Writes on tenant-owned entities include `tenant_id` in the predicate. Composite foreign keys prevent cross-tenant business/branch links. PostgreSQL RLS is planned in `docs/adr/ADR-002-postgres-rls.md`.

## Sessions

HttpOnly cookies carry a short-lived access JWT and a rotating refresh token. Cookie `secure`, `sameSite`, `path`, and `maxAge` come from validated env (`COOKIE_SECURE`, `COOKIE_SAMESITE`, JWT TTLs). Logout revokes the session row.

## Money

`@bizora/money` stores amounts as `bigint` minor units and ISO 4217 codes. FX uses `decimal.js` strings. Do not introduce `number` amounts. Base-currency locking is described in `docs/adr/ADR-003-currency-locking.md`.

## Module rule

Modules depend on published contracts, not another module’s tables.

See also `docs/security/tenancy.md`.
