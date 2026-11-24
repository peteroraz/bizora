# Bizora architecture overview

Bizora is a multi-tenant SaaS modular monolith for small traders. It covers:

- sales, at the counter and offline, including items typed in before they are products (`docs/catalog/QUICK_CATALOG.md`, ADR-049);
- customers, debtors and payments;
- stock;
- suppliers;
- jobs;
- expenses and cash;
- bank statement matching;
- double-entry books;
- invoices and receipts;
- staff, roles and shop phones;
- photo and voice capture into drafts;
- an Admin portal for Bizora staff.

Status: pre-pilot (`docs/PILOT_READINESS_STATUS.md`).

## Runtime

- `apps/web` — Next.js responsive PWA. Browser calls `/api/v1/*`, rewritten to the NestJS API so session cookies stay first-party.
- `apps/api` — NestJS modular monolith. Its modules (`apps/api/src/modules`) include:
  - identity, tenant, RBAC and audit;
  - customers, debtors, payments, sales, inventory;
  - suppliers, jobs, money, ledger, reconciliation;
  - documents, branding, capture, email, sync;
  - entitlements and switches, exports, telemetry and measures;
  - the Admin portal's API.
  `ai` and `crm` are empty folders for later work.
- `apps/admin` — Next.js Admin portal for Bizora staff (ADR-037, ADR-039, ADR-045), on its own origin, signed in with Google.
- `apps/worker` — Process placeholder for later jobs. Nothing runs there yet.
- PostgreSQL is the system of record. Redis is provisioned locally for later queues.
- Google Cloud Run + Cloud SQL is the target runtime. Secrets belong in Secret Manager.

## Tenancy

Organization is the security and billing tenant. A tenant owns businesses; businesses own branches. Every tenant-owned row stores `tenant_id`. Request tenant context is loaded from the verified session (`bid` / `br` claims persisted on the `sessions` row) and re-checked against the authenticated **ACTIVE** membership. Client `X-Tenant-Id`, `X-Organization-Id`, `X-Business-Id`, and `X-Branch-Id` headers are ignored. Change active business or branch only with `POST /api/v1/auth/select-context`.

Writes on tenant-owned entities include `tenant_id` in the predicate. Composite foreign keys prevent cross-tenant business/branch links. A route-by-route isolation matrix and a fingerprint of every tenant table are blocking tests (ADR-043). PostgreSQL RLS is not enabled; ADR-043 records why it is gated before general availability rather than before the pilot.

## Offline

The web app keeps an outbox in IndexedDB. Each queued change carries a device-made UUIDv7, which is also its idempotency key, and the shop it was made in. `/api/v1/sync/push` applies changes in order and answers applied, duplicate or rejected for each (ADR-012, ADR-014, ADR-044). A refused sale is kept for the owner to record or set aside (ADR-050). Remembered items, their other names and the shop's units are cached on the phone so a sale can be typed with no network (ADR-049).

## Ledger

Every sale, payment, expense and stock movement posts a balanced journal entry. Profit shown to the owner is that books figure, with a note when some sales have no cost (ADR-051). Entries, stock movements and returns cannot be changed or deleted: database triggers refuse it. Corrections are reversing entries (ADR-013). The only exception is removing a sample business with its script (ADR-045).

## Sessions

HttpOnly cookies carry a short-lived access JWT and a rotating refresh token. Cookie `secure`, `sameSite`, `path`, and `maxAge` come from validated env (`COOKIE_SECURE`, `COOKIE_SAMESITE`, JWT TTLs). Logout revokes the session row.

## Money

`@bizora/money` stores amounts as `bigint` minor units and ISO 4217 codes. FX uses `decimal.js` strings. Do not introduce `number` amounts. Base-currency locking is described in `docs/adr/ADR-003-currency-locking.md`.

## Module rule

Modules depend on published contracts, not another module’s tables.

See also `docs/security/tenancy.md`.
