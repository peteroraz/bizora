# ADR-036: Ready for real shops: error reporting, alerts, more than one API server, content security policy, restore drill

## Status

Accepted on 20 Nov 2026 (Sprint 8a). It follows the 19 Nov production-readiness review.

## Context

The review found gaps that matter as soon as real shops use Bizora:

- **No error reporting or alerts.** Nobody would know when something broke.
- **One API server only.** The sign-in limiter kept its counts in memory, so the API was capped at one Cloud Run instance.
- **No content security policy.** Nothing stopped an injected script from running in a page.
- **No restore practice.** Backups existed, but nobody had tried bringing one back.

## Decision

### Errors

- **Log format.** The API logs JSON that Cloud Logging understands: `severity` and `message` fields, with pino formatters.
- **What is reported.** Server faults go to Cloud Error Reporting in its own format (`ReportedErrorEvent`, with the stack first): unexpected errors, any 5xx, unhandled rejections and uncaught exceptions. Each report carries:
  - the request method and path;
  - the user;
  - the organization, business and shop affected;
  - the correlation ID.
- **What is not reported.** Caller mistakes (4xx) are not reported.
- **Tokens stay out.** Long tokens in paths, such as receipt and statement links, are replaced with `:token` before logging.
- **Web server.** Page rendering errors go through `onRequestError` in `instrumentation.ts`, in the same format, as service `bizora-web`.
- **Browsers.** A tiny inline script sends script errors to `POST /api/v1/telemetry/client-errors`, at most 5 per page.
  - The endpoint is public, rate-limited and takes small bodies only.
  - It keeps nothing; it only logs, as service `bizora-web-browser`.
  - The script is inline, so it adds nothing to any screen's JavaScript budget.

### Alerts (Terraform, `monitoring.tf`)

- **Uptime check** on `https://<custom domain>/health` every 5 minutes. It goes through the web app to the API.
- **Alerts:**
  - not answering for 10 minutes;
  - more than 5 server errors in 5 minutes;
  - more than 10 errors logged in 10 minutes;
  - database disk over 80%.
- **Who is told:** emails come from `alert_emails`. The monitoring, logging and Error Reporting APIs are enabled.
- **What to do:** `docs/runbooks/incidents.md` says what each alert means and the first steps.

### More than one API server

- **Shared counts.** The throttler's counts move to Postgres (`throttle_hits`, through `PostgresThrottlerStorage`), with the same fixed window and block rules as before. Every instance counts the same attempts. Old keys are cleared now and then.
- **Nothing else blocked scaling.** Idempotency keys, OAuth state, sessions, PIN attempts and AI usage were already in the database or in cookies, and there are no background timers.
- **New cap.** Terraform's API cap becomes `api_max_instances`, 4 by default. Redis is not needed.
- **A bug the end-to-end tests caught.** The query layer sent JavaScript dates in a form Postgres could not read. Dates now go as ISO text.

### Content security policy

- **Web pages.** The middleware gives every page a fresh nonce and this policy:
  - `script-src 'self' 'nonce-…' 'strict-dynamic'`: Next.js puts the nonce on its own scripts, and lazily loaded parts are allowed through `strict-dynamic`;
  - styles from self, with inline styles allowed (styles cannot run code);
  - images from self, `data:` and `blob:`;
  - `connect-src 'self'`, because the API is reached through the web app;
  - `media-src blob:` for voice notes;
  - `frame-ancestors 'none'`, `object-src 'none'`, `form-action 'self'`;
  - `upgrade-insecure-requests` on HTTPS;
  - `report-uri /api/v1/telemetry/csp`.

  The three inline scripts in the root layout (error reporter, theme, service worker) carry the nonce. Root pages were already rendered per request, so the nonce costs nothing extra.
- **The API** sends `default-src 'none'; frame-ancestors 'none'`, because its answers are data, PDFs and pictures, never runnable pages.
- **Reports.** Blocked content is logged as a warning, not an error, because single reports usually come from browser extensions.
- **Test.** An end-to-end test walks the main screens and a lazily loaded part, and fails on any blocked content or page error.

### Restores

- **Backups** were already on: daily, 7 kept, with point-in-time recovery in production.
- **The drill:** `docs/runbooks/restore-drill.sh`, run in Cloud Shell.
  1. Find the latest backup.
  2. Restore it into a temporary instance (never over `bizora-pg`).
  3. Check the data: migrations, row counts, the books balance, and stock matching its movements.
  4. Print how old the data is and how long the restore took.
  5. Delete the temporary instance.
- **Real incidents:** `docs/runbooks/restore.md` covers a real restore, including point in time.

## Consequences

- **Owner actions:**
  - run `terraform apply` for staging (alerts, uptime check, API cap), after adding an email to `alert_emails`;
  - run the restore drill once and record it in the drill log.
- **Browser reports** come from any visitor and are rate-limited per address. Error Reporting groups them, so a broken old phone shows as one group, not an alert storm. The "errors logged" alert counts them too, which is why its limit is 10.
- **Changing the policy:** anything new from another site (a payment provider's checkout script, a map) must be added in `apps/web/src/lib/csp.ts`.
