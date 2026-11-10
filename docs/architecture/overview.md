# Bizora architecture overview

Bizora is a multi-tenant SaaS modular monolith. Sprint 1 delivers the engineering spine, not business workflows.

## Runtime

- `apps/web` — Next.js responsive PWA. Browser calls `/api/v1/*`, which is rewritten to the NestJS API so session cookies stay first-party.
- `apps/api` — NestJS modular monolith. Identity, tenant, audit and health live here. CRM, sales, payments, inventory and AI are reserved module folders.
- `apps/worker` — Process placeholder for later jobs (BullMQ / Pub/Sub).
- PostgreSQL is the system of record. Redis is provisioned locally for later queues.
- Google Cloud Run + Cloud SQL is the target runtime. Secrets belong in Secret Manager.

## Tenancy

Organization is the security and billing tenant. A tenant owns businesses; businesses own branches. Every tenant-owned row stores `tenant_id`. Request tenant context is loaded from the authenticated membership after JWT verification. `X-Tenant-Id` / `X-Organization-Id` headers are ignored.

## Money

`@bizora/money` stores amounts as `bigint` minor units and ISO 4217 codes. FX uses `decimal.js` strings. Do not introduce `number` amounts.

## Module rule

Modules depend on published contracts, not another module’s tables.
