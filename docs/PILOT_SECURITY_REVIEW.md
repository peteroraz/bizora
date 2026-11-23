# Pilot security review (23 Nov 2026)

A focused application security review before the controlled pilot. It was done by reading the high-risk code paths and running the automated suites below; no external penetration test has been done. Severity uses Critical / High / Medium / Low.

**Result: no unresolved Critical or High finding in code.** One Medium item can only be confirmed on staging (rate-limit client address, S-3) and is a pilot condition.

## Findings

| # | Area | Finding | Severity | Status |
| --- | --- | --- | --- | --- |
| S-1 | Token leakage | Staging returned invitation tokens from the API (`INVITE_TOKEN_EXPOSE=true`), and nothing stopped a deployed service doing so. | High | **Fixed** (ADR-042). The API refuses to start in production with it on; staging Terraform and the deploy workflow set it off. Invitations go by email only. Test: `email-delivery.test.ts`. |
| S-2 | Unsafe logging | The console email provider logged full links with reset and invitation tokens, and full addresses. | Medium | **Fixed**. Tokens are hidden and addresses masked outside local development; the Resend adapter logs only kind, masked address, status and correlation ID. The API refuses the console provider in production. |
| S-3 | Rate-limit bypass / lockout | The web app forwards `/api` to the API, so the API may see the web service's address instead of the phone's. Sign-in limits (20 a minute per address) could then be shared by every user, locking everyone out at a busy hour, or be bypassed. | Medium | **Needs a staging check.** `TRUST_PROXY_HOPS` (default 1) is now configurable. Check: sign in from two phones on different networks and compare `ip` on the two `identity.login` rows in the audit log; if they are the same Google address, set `TRUST_PROXY_HOPS=2` on `bizora-api` (runbook). |
| S-4 | Object-level authorisation | `GET /customers/:id/followups` answered 200 (empty) for another business's customer instead of 404. No data leaked. | Low | **Fixed**, and covered by the tenant matrix. |
| S-5 | Double submission | Voids and approvals (sale void, payment void, expense approve and void, money movement void, supplier entry void, job cancel, stock count and request decisions) did not take an idempotency key. | Low | **Fixed**. Covered with replay and race tests in `financial-integrity.test.ts`. |
| S-6 | Tenant boundary at the database | No row-level security; isolation is in the application. | Medium (accepted for pilot) | **Gated** (ADR-043): a blocking cross-tenant matrix over every route with an id, every list and creates pointing at another business, with a row fingerprint of all 48 tenant tables. RLS is a blocking issue before general availability. |

## What was checked

| Risk | How it was checked | Result |
| --- | --- | --- |
| Authentication bypass | Every business route sits behind `TenantGuard` and `PermissionGuard`. The tenant comes from the signed token, never the client. Tests: `tenant-isolation.test.ts` (bad signatures, expired tokens, revoked sessions, suspended memberships, scope headers ignored), `sprint25-security.test.ts`. | OK |
| IDOR / broken object authorisation | `tenant-matrix.test.ts`: 77 routes with ids called with another business's real ids; all lists read; cross-business creates refused; offline sync refused; every tenant row unchanged. | OK after S-4 |
| CSRF | The business API uses a bearer token sent by the app, not an ambient cookie. Cookies (Google sign-in state, admin session) are `HttpOnly`, `SameSite=Lax` and `Secure` in production. The admin portal also needs the `x-bizora-admin` header and its own origin (`sprint8b.test.ts`). | OK |
| XSS | React escapes output. The only raw HTML is three fixed inline scripts carrying the page nonce. CSP has a nonce and `strict-dynamic`, with no `unsafe-inline` for scripts. Email templates escape every value. | OK |
| SSRF | The API makes outbound requests only to fixed addresses (Resend, Google OIDC discovery, Vertex AI); none come from user input. | OK |
| SQL injection | Drizzle with parameters throughout. The one `sql.raw` uses a constant (`WINDOW_DAYS`); migrations run fixed files. | OK |
| Unsafe upload | Product photos are checked from their bytes (real JPEG or PNG), with byte and pixel limits, kept per tenant in the database, and served only to signed-in users of that business. Statement and import uploads are size-limited JSON parsed by schemas. | OK (see storage section) |
| Path traversal | No file system reads from request data in the API. | OK |
| Insecure redirects | Sign-in `next=` is checked to stay on the site (`identity-oauth.test.ts`, "rejects open redirects"). | OK |
| Session fixation | A new session is made at sign-in; refresh tokens rotate; logout and password reset revoke sessions (`identity-oauth.test.ts`, `sprint25-security.test.ts`). | OK |
| Secret leakage | Secrets come from Secret Manager through env; none in source. `/health` exposes no secrets (tested). Logs carry no tokens (S-2). | OK |
| Admin/customer boundary | Separate session cookie and audience. Business tokens are refused by the portal and portal cookies by the business API; forged and tampered portal cookies are refused; support views are per business, read-only, one hour, reason required, logged in both logs, and the owner is emailed. Tests: `sprint8b.test.ts`, `admin-part2.test.ts`. | OK |
| Rate limits | Sign-up, sign-in, forgot password and receipt email are limited per client address in Postgres, so the limit holds across instances (`email-delivery.test.ts`). | OK, with S-3 to confirm |
| Dependencies | `pnpm audit --prod`: one High, ignored as a documented exception (ADR-004 Zod, ADR-023 picomatch); nothing new. Model files are pinned by commit and SHA-256 (ADR-041). | OK |

## Storage of images and documents

- **Product photos** live in Postgres (`product_photos`), scoped by tenant, with no public URL; they're served through authenticated, tenant-checked routes.
- **Receipts and invoices** are made on request. Public receipt links use a 24-byte random token (192 bits), so they can't be guessed. Anyone with the link can open it, by design for WhatsApp; it shows only that sale.
- **Logos** are public only through a receipt token.
- **Malware scanning:** photos are decoded and checked as images, and nothing else is stored as a file. Nothing is executed or shown as HTML. Scanning (e.g. Cloud Storage plus a scanner) is needed when other document uploads arrive.
- **Orphans:** photos are deleted with their product row; none are left in object storage because none use it.

## Not covered

- An external penetration test.
- Device-level security on shared shop phones beyond the existing shop PIN and auto-lock.
- Denial-of-service beyond per-address rate limits (Cloud Run scaling limits apply).
