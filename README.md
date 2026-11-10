# Bizora

AI-native, multi-tenant business operating platform. This repository currently contains **Sprint 1**: monorepo foundation, PWA shell, NestJS API, tenant model, authentication, isolation tests, CI and Cloud Run/SQL configuration.

Later sprints add CRM, catalog, sales documents, payments, inventory and Ask Zora. Do not implement those until Sprint 1 remains green.

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

## Quality gates

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm audit --prod
```

Tenant isolation tests in `apps/api/src/tenant-isolation.test.ts` are blocking.

## Deploy (Google Cloud)

1. Apply `infra/terraform` (enables Cloud Run, Cloud SQL, Secret Manager, Artifact Registry).
2. Store `DATABASE_URL` and `JWT_SECRET` in Secret Manager — never in git.
3. Build and push `apps/api/Dockerfile` and `apps/web/Dockerfile`.
4. Apply `infra/cloudrun/*.yaml` with project, region and image names substituted.
5. Run migrations against Cloud SQL before shifting traffic.

See `docs/architecture/overview.md` and `docs/adr/ADR-001-stack.md`.
