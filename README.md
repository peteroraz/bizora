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

## Deploy (Google Cloud)

1. Apply `infra/terraform` (enables Cloud Run, Cloud SQL, Secret Manager, Artifact Registry).
2. Store `DATABASE_URL` and `JWT_SECRET` in Secret Manager — never in git.
3. Build and push `apps/api/Dockerfile` and `apps/web/Dockerfile`.
4. Apply `infra/cloudrun/*.yaml` with project, region and image names substituted.
5. Run migrations against Cloud SQL before shifting traffic.
