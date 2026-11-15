# Tenancy, sessions, and authorization

## Hierarchy

Organization (tenant) → Business → Branch. Every tenant-owned row stores `tenant_id`. Client `X-Tenant-Id`, `X-Organization-Id`, `X-Business-Id`, and `X-Branch-Id` headers are ignored. Active business/branch comes from the verified session, not from the request.

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
- 2+ → preauth session and `needsWorkspaceSelection`. `/select-workspace` loads `GET /api/v1/auth/workspaces` (that caller's ACTIVE memberships only; a preauth or access session both work) and then calls `POST /api/v1/auth/select-context`

Switching to an organization without an active membership returns 403.

`POST /api/v1/auth/select-context` is the only way to change the active business or branch. Org-wide members who omit `businessId` receive the same default as login: the sole business (and its sole branch) when the organization has exactly one. Business-scoped members with exactly one branch receive that branch automatically.

## Session lifecycle

- Short-lived access JWT (`bizora_session`) and rotating refresh token (`bizora_refresh`).
- Refresh tokens are stored hashed. Logout sets `revoked_at`. Reuse of a rotated refresh token revokes the family.
- Protected routes load membership from the database. JWT `role` is never trusted for authorization.
- Password reset revokes every session for that user. Google sign-in reuses this same session issuance. A verified provider sign-in that matches an unverified password account also revokes every session and clears that password. See `docs/adr/ADR-008-oidc-sign-in.md` and `docs/adr/ADR-009-sign-in-providers.md`.

## Shop staff sessions

Staff without email sign in with a PIN, only on a shop device enrolled by an owner or manager. The session is bound to that device through the httpOnly `bizora_device` cookie and is re-checked on every request and refresh. Removing or suspending the device ends its sessions. See `docs/adr/ADR-010-staff-pin-devices-and-plans.md` and `docs/security/roles.md`.

## Access by job function

What each role may do, which rows it gets back (branch, own follow-ups, counter lookup) and which fields (a cashier gets a customer's name and the last 4 digits of the phone only) are set out in `docs/security/roles.md` and `docs/adr/ADR-011-job-function-access.md`.

## Invite lifecycle

Pending invites are unique per tenant+email. Accept is a single `PENDING` → `ACCEPTED` update. Revoke and resend exist. Tokens appear in API responses only when `INVITE_TOKEN_EXPOSE=true`. The accept link is always included in the invitation email.

## Currency locking

See `docs/adr/ADR-003-currency-locking.md`. Base currency may change until a financial module reports posted transactions.
