# Tenancy, sessions, and authorization

## Hierarchy

Organization (tenant) → Business → Branch. Every tenant-owned row stores `tenant_id`. Client `X-Tenant-Id` / `X-Organization-Id` headers are ignored.

## Membership scope

- Organization-wide: `business_id` and `branch_id` are null. May act in any business/branch in the tenant.
- Business-scoped: locked to that business; may pick a branch inside it; cannot name another business.
- Branch-scoped: locked to that exact business and branch; cannot widen to the business.

`resolveAssignableScope` in the API is the shared helper. Invite, branch create, and settings writes reuse it.

Country and base currency require business or organization authority, not a branch-only membership. Organization branding requires organization-wide scope.

## Workspace selection

Login considers **ACTIVE** memberships only.

- 0 → `NO_MEMBERSHIP`
- 1 → session issued for that workspace
- 2+ → `needsWorkspaceSelection` with safe workspace metadata; `/select-workspace` calls `POST /api/v1/auth/select-context`

Switching to an organization without an active membership returns 403.

## Session lifecycle

- Short-lived access JWT (`bizora_session`) and rotating refresh token (`bizora_refresh`).
- Refresh tokens are stored hashed. Logout sets `revoked_at`. Reuse of a rotated refresh token revokes the family.
- Protected routes load membership from the database. JWT `role` is never trusted for authorization.

## Invite lifecycle

Pending invites are unique per tenant+email. Accept is a single `PENDING` → `ACCEPTED` update. Revoke and resend exist. Tokens appear in API responses only when `INVITE_TOKEN_EXPOSE=true`.

## Currency locking

See `docs/adr/ADR-003-currency-locking.md`. Base currency may change until a financial module reports posted transactions.
