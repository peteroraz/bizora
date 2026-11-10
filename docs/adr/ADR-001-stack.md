# ADR-001: Sprint 1 stack

## Status

Accepted for Sprint 1.

## Context

The Master Build Specification names pnpm + Turborepo, Next.js, NestJS, PostgreSQL, Redis, Google Cloud, and Prisma or Drizzle.

## Decision

- Monorepo: pnpm workspaces + Turborepo.
- Web: Next.js App Router, Tailwind CSS, shared `@bizora/ui` primitives (shadcn-style).
- API: NestJS 11 modular monolith, ESM.
- ORM: **Drizzle** with versioned SQL migrations in `apps/api/drizzle`.
- Tests: Vitest. Tenant isolation uses PGlite so CI does not require Docker, while local/dev/prod remain PostgreSQL.
- Auth: Argon2id passwords + HS256 JWT in an HttpOnly cookie, with Bearer support for API clients. Claims are re-checked against `memberships` on every request. OIDC providers can replace password verification later without changing tenant guards.
- Logging: Pino, with `X-Correlation-Id` on every response/error envelope.

## Consequences

- Prisma is not used. Switching later would be a new ADR.
- PGlite is a test double for PostgreSQL, not a production database.
- Social/OIDC login and MFA are architected (token + membership), not implemented.
