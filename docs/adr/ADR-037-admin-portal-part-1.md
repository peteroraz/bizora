# ADR-037: Admin portal, part 1: staff sign-in, finding businesses and people, support actions

## Status

Accepted on 20 Nov 2026 (Sprint 8b). Part 2 adds the support view of a business's records, with the owner's consent, and per-business limits.

## Context

Once real shops use Bizora, Bizora's own team needs to answer "my cashier never got the invite", "a tablet was stolen" or "which plan are we on?" without asking an engineer to query the database. That needs a back office that:

- only Bizora staff can open, with clear roles;
- shows a business's account but not its sales, money or customers;
- records who did what and why, both for Bizora and for the business owner.

## Decision

### A separate app on a separate address

- **App.** `apps/admin`, a small Next.js app, runs as Cloud Run service `bizora-admin`. Staging maps it to `admin-staging.baseportals.app`; production stays on run.app until a load balancer is designed.
- **API.** Routes live under `/api/admin/v1` in the same API, with their own guard. The portal's Next server forwards only `/api/admin/*`; the business app no longer forwards `/api/admin/*` at all.
- **Look.** Same component kit, its own colours (aubergine bar, violet actions), and a yellow band on every screen outside production. Never indexed (`X-Robots-Tag`, `robots.txt`), never framed, nonce-only scripts, `no-store`.

### Staff and sign-in

- **Who.** Staff are rows in `admin_staff`, never business users. A business sign-in cannot open the portal, and a portal sign-in cannot open the business app.
- **How.** Google sign-in only, with the same OAuth client as the business app and a second return address: `<admin origin>/api/admin/v1/auth/google/callback`.
  - The sign-in transaction is sealed with its own key (`JWT_SECRET` + `:admin-portal`), so a business sign-in can never finish an admin one.
  - Google must have confirmed the email address.
  - The Google account is pinned on first sign-in; the same email from another Google account is refused.
- **Allow-list.** Only listed emails get in. `ADMIN_BOOTSTRAP_EMAILS` (Terraform `admin_bootstrap_emails`) names the first super admins; each becomes one on first sign-in. After that, super admins add and remove staff in the portal.
- **Session.** A random token in an httpOnly cookie, hashed in `admin_sessions`, 8 hours. On HTTPS the cookie is `__Host-bizora_admin`, tied to the portal's own address. Removing someone ends their sessions.
- **Refusals** are logged (`staff.sign_in_refused`) with the reason.

### Requests from other sites are refused

The portal and the business app share a parent domain, so cookies alone are not enough. The admin guard refuses a request:

- whose `Origin` is not the portal's address;
- whose `Sec-Fetch-Site` is anything but `same-origin` or `none`;
- that changes something without the `x-bizora-admin: 1` header.

CORS is turned off for `/api/admin/*`, so a browser on the business app's address cannot read admin answers.

### Roles

A person can hold several roles. Every admin route names the ability it needs; a route that names none is refused.

| Ability | super_admin | support | operations | finance | viewer |
| --- | --- | --- | --- | --- | --- |
| Find businesses and people | ✓ | ✓ | ✓ | ✓ | ✓ |
| Resend links, sign people out | ✓ | ✓ | ✓ | | |
| Stop a shop phone | ✓ | ✓ | ✓ | | |
| Read the staff log | ✓ | | ✓ | | |
| Manage staff | ✓ | | | | |

There is always at least one super admin: the last one cannot be removed or lose the role, and nobody can remove themselves.

### What staff can see

- **Business.** Name, link name, phone, plan, sign-up, setup and last activity; businesses; shops (open, locked or closed); people and their last sign-in; waiting invitations; shop phones; photo and voice reads per shop (today and 30 days); stored photo size; Bizora's support history for that business.
- **Person.** How they sign in, whether the email is confirmed, how many devices are signed in, last seen, businesses and waiting invitations.
- **Not shown.** Sales, money, customers, stock, tokens and password hashes. Seeing records needs the owner's consent (part 2).
- **Looking is logged.** Opening a business or a person writes `business.viewed` or `person.viewed` to the staff log.

### Support actions

- **Actions.** Resend an invitation (fresh link, old one stops working), resend the confirmation email, sign a person out everywhere, stop a shop phone.
- **Same effect.** Each uses the same code path as the owner's own action (`resendForSupport`, `stopForSupport`, `revokeAllForUser`).
- **A reason is required** (5 to 500 characters).
- **Two logs.**
  - `admin_audit`, the staff log, which is never edited.
  - The business's own `audit_events`, with actor type `BIZORA_SUPPORT`, source `ADMIN_PORTAL`, no user ID, and the staff email and reason in the metadata. Signing someone out everywhere is written to every business they work in.

## Consequences

- The owner must:
  - add the return address to the Google OAuth client;
  - create the DNS record;
  - put their Google account in `admin_bootstrap_emails`;
  - run `terraform apply`.
  The deploy skips `bizora-admin` until it exists.
- The portal is public on the internet behind Google sign-in. Identity-Aware Proxy in front of it needs a load balancer and is left for the production load balancer work.
- Part 2 adds the owner-consented support view and per-business limits, on top of the same guard, roles and logs.
