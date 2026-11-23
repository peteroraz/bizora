# Bizora

A multi-tenant business platform for small traders: sales at the counter and offline, customers and what they owe, stock, suppliers, jobs, expenses and cash, double-entry books behind every record, invoices and receipts, staff with roles and shop phones, and an Admin portal for Bizora's own staff.

**Status: pre-pilot.** It is being made ready for a controlled pilot with a few Nigerian businesses. It is not generally available and holds no security or data protection certification. Where each part stands: `docs/PILOT_READINESS_STATUS.md`. The verdict: `docs/PILOT_READINESS_REPORT.md`. How to deploy and run the pilot: `docs/PILOT_DEPLOYMENT_RUNBOOK.md`.

Not built: card or online payment gateways, automatic WhatsApp messages, AI agents ("Ask Zora"), PostgreSQL row-level security (ADR-043), billing.

## Prerequisites

- Node.js 22+
- pnpm 10.12.1 (`corepack enable` or `npm i -g pnpm`)
- PostgreSQL 16 (Docker Compose is the documented path)

## Local setup

```bash
cp .env.example .env
docker compose up -d postgres redis
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
```

- Web: http://localhost:3000
- API health: http://localhost:3001/health
- Admin portal (Bizora staff, ADR-037): `pnpm --filter @bizora/admin dev`, then http://localhost:3002. It needs `ADMIN_WEB_ORIGIN=http://localhost:3002`, Google sign-in settings and `ADMIN_BOOTSTRAP_EMAILS` on the API.
- Seeded users (local only): `alice@tenant-a.test` / `bob@tenant-b.test` with password `LocalOnly!Passw0rd`

Invite tokens are omitted from API responses unless `INVITE_TOKEN_EXPOSE=true` (local/dev only).

## Quality gates

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm audit --prod
```

Tenant isolation tests (`apps/api/src/tenant-isolation.test.ts`, and the route-by-route matrix `tenant-matrix.test.ts` from ADR-043) are blocking. CI also runs the browser tests (`apps/web/e2e`, `apps/admin/e2e`), Gitleaks and Terraform validation.

Pilot checks: `node --experimental-strip-types scripts/pilot-readiness-check.ts` (add `--url <staging>` to check a running environment). Performance: `scripts/perf-baseline.ts` (`docs/PILOT_PERFORMANCE_BASELINE.md`).

The remaining `pnpm audit` exception is documented in `docs/adr/ADR-004-pnpm-audit-exception.md`.

## Tenancy and auth

See `docs/security/tenancy.md`, `docs/architecture/overview.md`, and ADRs under `docs/adr/`.

Tenant context is server-derived from the verified session. Do not send `X-Tenant-Id`, `X-Organization-Id`, `X-Business-Id`, or `X-Branch-Id` — those headers are ignored. Use `POST /api/v1/auth/select-context` to change the active business or branch.

## Deploy (Google Cloud)

See `docs/deployment.md` for the first-time runbook: state buckets, Terraform, the JWT secret, GitHub environments, deploy, rollback, and logs.

Images are built from `apps/api/Dockerfile`, `apps/web/Dockerfile` and `apps/admin/Dockerfile` and deployed by `.github/workflows/deploy.yml`. Do not apply `infra/cloudrun/*.yaml`.

Set `TRUST_PROXY=true` in production. The API trusts `TRUST_PROXY_HOPS` hops (default 1). Check the right number on staging before the pilot (runbook, step 4): requests reach the API through the web service.

## Known limitations

- **Row-level security** is not enabled in PostgreSQL. Isolation between businesses is enforced in the API from the signed-in session, and is tested route by route (ADR-043). It is required before general availability (issue #43).
- **Email** is sent by Resend on staging. Production refuses the console provider. Invitation links are never returned by the API in staging or production (ADR-042).
- **Offline voice sales** are experimental (ADR-040, ADR-041, ADR-044, `docs/voice/README.md`):
  - English only, measured on read-out Nigerian English and a few Pidgin-influenced sentences (`docs/voice/benchmark.md`), not on real market sales or physical phones;
  - every sale is reviewed before it is saved;
  - the models (Standard about 77 MB, Best accuracy about 249 MB) are fetched at build time and checked against `apps/web/src/lib/voice/models.lock.json`.
- **Sign-in limits** (`@nestjs/throttler`) are kept in Postgres (ADR-036), so every `bizora-api` instance counts the same attempts.
- **Restores** are documented (`docs/runbooks/restore.md`), but the drill has not been run yet, so no recovery time is promised.
- More limits, by area: `docs/deployment.md`, Known limitations.
