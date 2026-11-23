# ADR-042: Email delivery for the pilot

## Status

Accepted on 23 Nov 2026.

## Context

Real businesses can't be given invitation tokens by hand. Before the pilot, Bizora had:

- an email port with two providers, Resend and console (log only);
- invitation, verification and password-reset emails.

But:

- there were no retries;
- the console provider logged links that carry tokens;
- a deployed service could start with no real provider;
- staging returned invitation tokens from the API (`INVITE_TOKEN_EXPOSE=true`).

## Decision

- **Provider separation stays.** `EmailPort` is the interface; Resend is the first provider. Another provider (SES, Postmark, SendGrid) is one adapter plus a value of `EMAIL_PROVIDER`.
- **Retries.** Up to three tries (0.5 s and 1.5 s apart) on 429, 5xx or network failure, all with **one idempotency key**, so the provider sends the message once even if a reply is lost. A refused message (4xx) is not retried.
- **Safe logging.**
  - Logs carry the kind of email, the correlation ID, a masked address (`n***@shop.ng`), the attempt and the status, never the body.
  - The console provider hides `token=`, `code=` and receipt tokens everywhere except local development.
- **Production guards** (`NODE_ENV=production`): the API refuses to start with the console provider or with `INVITE_TOKEN_EXPOSE=true`.
  - Staging's Terraform value is now `false`.
  - The deploy workflow sets `INVITE_TOKEN_EXPOSE=false` on the API service, so a service created before that change keeps starting.
- **Emails sent:**
  - invitation;
  - email verification;
  - password reset;
  - **password changed** (new, after a reset; says sessions were ended);
  - **support access** (new, to the owner when Bizora support opens their records, with the reason);
  - **receipt or invoice link** (new, `POST /api/v1/sales/:id/email`; anyone who can see the sale; rate-limited; audited with the recipient's domain only; the address is not stored).
- **Not sent:** sign-in alerts for every new device. That's not needed for a controlled pilot and would be noisy on shared shop phones.

## Configuration

| Variable | Required | Notes |
| --- | --- | --- |
| `EMAIL_PROVIDER` | yes in production | `resend` (or `console` for local and tests only) |
| `EMAIL_API_KEY` | with `resend` | Secret Manager secret `email-api-key`, never in source |
| `EMAIL_FROM` | with `resend` | e.g. `Bizora <no-reply@mail.baseportals.app>`; the domain must be verified in Resend (SPF and DKIM) |
| `PUBLIC_WEB_ORIGIN` | recommended | The address used in email links |
| `INVITE_TOKEN_EXPOSE` | must be `false` in production | Only for local development and tests |

## Consequences

- If Resend is down for longer than the retries, the action still succeeds and the failure is logged. The person can ask again (resend invitation, forgot password).
- Tests: `apps/api/src/email-delivery.test.ts` covers retries, idempotency, safe logs, production guards, invitations by email only, password-changed notices, receipt email and reset limits. `admin-part2.test.ts` covers the support access email.
