# ADR-010: Shop staff on enrolled devices, and plan limits

## Status

Accepted. Implements section 3 (roles and staff without email) and section 9 (plans) of Spec Addendum v1.2.

## Context

Many Nigerian shops share one phone or tablet at the counter. Sales staff often have no email address and do not want a password. The owner must still know who recorded each sale, be able to stop a person or a lost phone at once, and keep staff out of settings and cost prices.

Bizora has no billing yet, but the plan limits in the addendum (branches, staff, devices) must be enforced now so that later billing does not change behaviour.

## Decision

### Staff accounts

- `users.kind` is `person` or `staff`. A staff user has no email and no password. Database checks enforce both (`users_person_email_ck`, `users_staff_no_credentials_ck`).
- Staff are created by an owner, administrator or manager under **Settings → Staff** (`staff.manage`). They get one of the existing roles `SALES`, `CASHIER`, `INVENTORY` or `EMPLOYEE`. The UI calls them Sales staff, Cashier, Storekeeper and Employee. No new role enum values were added.
- A staff member always belongs to exactly one branch. A branch-scoped manager can only add staff to their own branch.
- The PIN is 4 to 6 digits. Repeated digits (`1111`) and runs (`1234`, `9876`) are refused. It is stored with argon2id in `staff_credentials`.

### Shop devices

- `devices.manage` turns on Shop mode on the current browser. The API creates a `shop_devices` row and sets an httpOnly, Secure, SameSite=Lax cookie `bizora_device` with a random 32-byte token for 365 days. Only its SHA-256 is stored.
- A device belongs to one branch. The PIN screen lists only active staff of that branch.
- A PIN is accepted only together with a valid device cookie. There is no PIN login on a browser without one.
- The session issued after a PIN login stores `sessions.device_id`. Every authenticated request and every refresh re-checks that the cookie still matches an unrevoked, unsuspended device of the same tenant. Copying the session cookies to another browser does not work.
- A staff session cannot select another workspace, create an organization, set a password, link Google, manage staff or enrol devices.
- Staff refresh tokens use `STAFF_SESSION_TTL` (default 12 hours) instead of the normal refresh lifetime.
- Audit events from these sessions have `actor_type = 'STAFF_PIN'` and carry the membership, so each sale can be traced to a person and a device.

### Lockouts

- 5 wrong PINs for one staff member on any device → that staff member is locked for 15 minutes.
- 20 wrong PINs on one device within 24 hours → the device is suspended, and its sessions end. An owner or manager approves it again under Settings → Staff.
- Attempts are counted from `staff_pin_attempts`. The device row is locked with `SELECT … FOR UPDATE` during a PIN check, so parallel guesses are counted correctly.
- Resetting a PIN, turning a staff member off, removing a device or suspending it ends the affected sessions at once.

### Auto-lock

The web app locks a staff session after 5 minutes without input and returns to the staff list. A Lock button does the same at any time.

### Plans

- `plans` holds `starter` (1 branch, 2 staff, 2 devices) and `business` (5 branches, 25 staff, 10 devices), with feature flags.
- `organization_plans` gives each organization one plan. Existing organizations were moved to `starter`. New organizations get `DEFAULT_PLAN_CODE`, or `starter` when it is not set.
- Staff usage counts active non-owner memberships and pending, unexpired invitations.
- Going over a limit returns HTTP 402 with code `PLAN_LIMIT` and a plain-language message.

## Consequences

- Plan changes are a database update until billing exists (see `docs/deployment.md`, Known limitations).
- Limit checks happen before the insert, not in a database constraint. Two parallel requests could both pass. This is acceptable for soft commercial limits.
- Auto-lock runs in the browser. The server-side guarantee is the 12-hour staff refresh lifetime and immediate revocation.
- The new `prices.cost.read` and `reports.profit.read` permissions are reserved for Sprint 4 products and later reports. Nothing reads them yet.
