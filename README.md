# Bizora

AI-native, multi-tenant business operating platform. This repository currently contains **Sprint 1–2.5**: monorepo foundation, PWA shell, NestJS API, tenant model, authentication, onboarding/RBAC, session and tenancy hardening, isolation tests, CI and Cloud Run/SQL configuration.

Later sprints add CRM, catalog, sales documents, payments, inventory and Ask Zora. Do not implement those until the current gates remain green.

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

Tenant isolation tests in `apps/api/src/tenant-isolation.test.ts` are blocking. CI also runs Gitleaks.

The remaining `pnpm audit` exception is documented in `docs/adr/ADR-004-pnpm-audit-exception.md`.

## Tenancy and auth

See `docs/security/tenancy.md`, `docs/architecture/overview.md`, and ADRs under `docs/adr/`.

Tenant context is server-derived from the verified session. Do not send `X-Tenant-Id`, `X-Organization-Id`, `X-Business-Id`, or `X-Branch-Id` — those headers are ignored. Use `POST /api/v1/auth/select-context` to change the active business or branch.

## Deploy (Google Cloud)

See `docs/deployment.md` for the first-time runbook: state buckets, Terraform, the JWT secret, GitHub environments, deploy, rollback, and logs.

Images are built from `apps/api/Dockerfile` and `apps/web/Dockerfile` and deployed by `.github/workflows/deploy.yml`. Do not apply `infra/cloudrun/*.yaml`.

Set `TRUST_PROXY=true` in production. The API trusts **1 hop** (`X-Forwarded-For` from Cloud Run). If a Google external HTTPS load balancer is placed in front of Cloud Run, set trust to **2 hops**.

## Known limitations

- Auth throttling (`@nestjs/throttler`) is **in-memory per Cloud Run instance**. Terraform caps `bizora-api` at one instance until the throttler moves to Redis-backed storage. Limits can be bypassed if that cap is raised first.
- There is no custom domain yet. The public URLs are the Cloud Run `run.app` hosts.
- There is no email delivery yet. Invite tokens are returned by the API only when `INVITE_TOKEN_EXPOSE=true` (staging). Production leaves that off.
- PostgreSQL RLS is not enabled yet (`docs/adr/ADR-002-postgres-rls.md`).
- CRM, catalog, sales, payments, inventory, and Ask Zora are not implemented.
