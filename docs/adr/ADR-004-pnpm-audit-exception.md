# ADR-004: pnpm audit exception GHSA-mrhx-c7xc-m3w5

## Status

Accepted until the advisory is patched or confirmed exploitable in this repo.

## Context

`pnpm.auditConfig.ignoreGhsas` currently lists `GHSA-mrhx-c7xc-m3w5` so `pnpm audit --prod` can stay a blocking CI gate for every other advisory.

This GitHub advisory is the Zod email ReDoS issue (`z.string().email()`). Bizora uses Zod 3.25.x for request validation, including emails on register/login/invite.

## Why it is retained

- There is no Zod 3.x release that removes the advisory without a breaking Zod 4 migration.
- Attack surface is authenticated or public auth endpoints that are rate-limited (`THROTTLE_AUTH_LIMIT`).
- Payloads are already length-capped (email via Zod email, passwords 12–128).

## Removal trigger

Remove the ignore (and fail CI) when any of these is true:

- Zod publishes a 3.x fix, or Bizora upgrades to a Zod 4 release that patches the advisory.
- Auth rate limits are removed.
- A proof-of-concept shows unauthenticated impact beyond CPU on the already-throttled login/register/invite-accept routes.

Do not add further GHSA ignores without a new ADR.
