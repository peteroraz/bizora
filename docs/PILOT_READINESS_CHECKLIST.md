# Pilot readiness checklist

Every gate must pass before `v0.9.0-pilot` is tagged. Status as of **24 Nov 2026**. The verdict and blockers are in `docs/PILOT_READINESS_REPORT.md`.

- **Automated gates** run in CI on every pull request: lint, typecheck, unit and integration tests, build, `pnpm audit --prod`, Gitleaks, Docker builds, Terraform, and the browser tests. `node --experimental-strip-types scripts/pilot-readiness-check.ts` checks the repository, and `--url … --write` checks staging.
- **People-only gates** pass only when their evidence is written where the gate says.
- **Test links:**
  - API tests are in `apps/api/src/`;
  - browser tests are in `apps/web/e2e/`;
  - Admin portal tests are in `apps/admin/e2e/`.

  Tests named with a PR number arrive with that PR.

## Identity and security

| # | Gate | Automated test | Status |
| --- | --- | --- | --- |
| G5 | No unresolved Critical or High security finding | `sprint25-security.test.ts`, `review-guards.test.ts`; review in `PILOT_SECURITY_REVIEW.md` | Passes. S-3 (Medium) needs staging |
| G3 | Tenant isolation: every route probed as another business, every tenant table fingerprinted, coverage gate | [`tenant-matrix.test.ts`](../apps/api/src/tenant-matrix.test.ts), [`tenant-isolation.test.ts`](../apps/api/src/tenant-isolation.test.ts) | Passes on `main` and on every open PR |
| G6 | Invitation links not returned by the API on staging or production | [`email-delivery.test.ts`](../apps/api/src/email-delivery.test.ts); staging: readiness check `--write` | Code passes; **staging not checked** |
| G7 | Sign-in limits count the real client address (S-3) | Readiness check `--write`; runbook step 4 | **Not checked** (no staging access) |
| G8 | Email reaches a real inbox: confirm email, reset, password changed, invitation, receipt, support notice | [`email-delivery.test.ts`](../apps/api/src/email-delivery.test.ts) (sending, retries, masking); a real inbox by hand (runbook step 6) | Code passes; **inbox not checked** |
| G21 | Sign-in, Google sign-in, sessions and roles | [`identity-oauth.test.ts`](../apps/api/src/identity-oauth.test.ts), [`rbac.test.ts`](../apps/api/src/rbac.test.ts), [`job-function-access.test.ts`](../apps/api/src/job-function-access.test.ts), [`session-and-days.e2e.ts`](../apps/web/e2e/session-and-days.e2e.ts) | Passes |
| G22 | Terms accepted at sign-up and again after a new version; support access read-only, logged, emailed | [`admin-part2.test.ts`](../apps/api/src/admin-part2.test.ts) (version 2026-11-24), [`terms.e2e.ts`](../apps/web/e2e/terms.e2e.ts), [`admin-portal.e2e.ts`](../apps/admin/e2e/admin-portal.e2e.ts) | Passes |
| G23 | Pages refuse outside scripts (content security policy) | [`content-security.e2e.ts`](../apps/web/e2e/content-security.e2e.ts) | Passes |
| G18 | Terms and privacy carry the pilot wording | `admin-part2.test.ts`; text in `apps/web/messages/en.json` (`legal`) | Done in this PR; counsel's review before general availability |

## Business operations

| # | Gate | Automated test | Status |
| --- | --- | --- | --- |
| G4 | Money integrity: every money path, double submits, races, books balance | [`financial-integrity.test.ts`](../apps/api/src/financial-integrity.test.ts), [`ledger.test.ts`](../apps/api/src/ledger.test.ts) | Passes |
| G24 | Sales: counter, desk flow, typed items, returns, credit | [`sales.test.ts`](../apps/api/src/sales.test.ts), [`desk-flow.test.ts`](../apps/api/src/desk-flow.test.ts), [`typed-items.test.ts`](../apps/api/src/typed-items.test.ts), [`sales.e2e.ts`](../apps/web/e2e/sales.e2e.ts), [`returns.e2e.ts`](../apps/web/e2e/returns.e2e.ts); return limit and credit terms: `returns-terms.test.ts` (#63) | Passes |
| G25 | Books for every business type, including after a change of type | `books-after-type-change.test.ts` (#59) | **Waits for #59** (blocker B1) |
| G26 | Money screens: expenses, cash, POS cash-out, profit | [`profit-from-sales.test.ts`](../apps/api/src/profit-from-sales.test.ts), [`profit-always-shown.test.ts`](../apps/api/src/profit-always-shown.test.ts), [`money.e2e.ts`](../apps/web/e2e/money.e2e.ts), [`pos-cashout.e2e.ts`](../apps/web/e2e/pos-cashout.e2e.ts) | Passes |
| G27 | Stock: stock in, counts, transfers, warehouses, catalog, price lists | [`stock.test.ts`](../apps/api/src/stock.test.ts), [`stock-operations.test.ts`](../apps/api/src/stock-operations.test.ts), [`catalog.test.ts`](../apps/api/src/catalog.test.ts), [`pricing.test.ts`](../apps/api/src/pricing.test.ts), [`stock.e2e.ts`](../apps/web/e2e/stock.e2e.ts), [`transfers.e2e.ts`](../apps/web/e2e/transfers.e2e.ts) | Passes |
| G28 | Inventory phase 5: attributes, batches, serials, reorder | `attributes.test.ts`, `batches.test.ts`, `serials.test.ts`, `reorder.test.ts`, and their `.e2e.ts` (#64–#67) | Pass on their PRs; wait for merge |
| G29 | Product files, scanning, search at 50,000 products | `product-file.test.ts`, `product-file.e2e.ts` (#69); `barcode-scan.e2e.ts` (#70); `scripts/perf-catalog.ts` (#71) | Pass on their PRs; wait for merge |
| G30 | Reports: sales by week, month, year | `sales-report.test.ts`, `sales-report.e2e.ts` (#62) | Passes on #62; waits for merge |
| G14 | No external payment gateway; no AI agents | [`pilot-operations.test.ts`](../apps/api/src/pilot-operations.test.ts) (payment switch locked off) | Done |
| G15 | Owners can download their records | [`pilot-operations.test.ts`](../apps/api/src/pilot-operations.test.ts), [`pilot-operations.e2e.ts`](../apps/web/e2e/pilot-operations.e2e.ts) | Done |
| G16 | Pilot measures and support tools in the Admin portal | [`pilot-operations.test.ts`](../apps/api/src/pilot-operations.test.ts), [`admin-portal.e2e.ts`](../apps/admin/e2e/admin-portal.e2e.ts) | Done |

## Offline

| # | Gate | Automated test | Status |
| --- | --- | --- | --- |
| G11 | Sales kept through failures, reloads and tabs, sent once, kept in their shop | [`offline-hardening.e2e.ts`](../apps/web/e2e/offline-hardening.e2e.ts), [`offline.e2e.ts`](../apps/web/e2e/offline.e2e.ts), [`offline-sync.test.ts`](../apps/api/src/offline-sync.test.ts) | Passes in the browser; **not on a real phone** |
| G31 | Offline sales never discarded; "Sales that need you" | [`offline-sales-kept.test.ts`](../apps/api/src/offline-sales-kept.test.ts) | Passes |
| G32 | New products, stock changes and count lines offline; counts compared at the time counted | `offline-work.test.ts`, `offline-stock.e2e.ts` (#68) | Passes on #68; waits for merge |
| G13 | Voice: experimental, reviewed before saving, typed fallback, switchable per business | [`voice-offline.e2e.ts`](../apps/web/e2e/voice-offline.e2e.ts), [`voice-model.e2e.ts`](../apps/web/e2e/voice-model.e2e.ts), [`voice-sync.test.ts`](../apps/api/src/voice-sync.test.ts); several sales: `multi-sale.e2e.ts` (#61) | Done; **real speech and real phones not tried** |

## Reliability and UX

| # | Gate | Automated test | Status |
| --- | --- | --- | --- |
| G1 | CI green on `main`: lint, typecheck, tests, build, audit, Gitleaks, Docker, Terraform | GitHub checks on `main` | Green at #57. **Not yet with #58–#72 together** (B2) |
| G2 | Browser tests green | CI `e2e` job | Green on `main` and on every open PR. The loading-speed check sometimes goes a few ms over its 2,500 ms limit on GitHub's machines and passes on re-run |
| G33 | Plain words in every error, with a support code on server faults | [`error-wording.test.ts`](../apps/api/src/error-wording.test.ts) | Passes |
| G34 | Small screens: no sideways scrolling, tap targets of 40 px or more | [`mobile-layout.e2e.ts`](../apps/web/e2e/mobile-layout.e2e.ts); stock screens: `stock-mobile.e2e.ts` (#72) | Passes |
| G35 | Quick sale script within 170 kB; screens within loading-speed budgets | [`performance-budget.e2e.ts`](../apps/web/e2e/performance-budget.e2e.ts) | Passes (159–160 kB) |
| G36 | A new business's first records saved at once without deadlock | [`concurrent-first-records.e2e.ts`](../apps/web/e2e/concurrent-first-records.e2e.ts) | Passes |
| G9 | Backups present; point-in-time recovery on in production | Runbook step 5, logged in `restore.md` | **Not checked** |
| G10 | A restore drill has been run and logged | `docs/runbooks/restore-drill.sh`; log in `restore.md` | **Not done** |
| G12 | Android: at least 3 real phones pass the matrix, one with 2 GB of memory or less | `docs/PILOT_MOBILE_TEST_MATRIX.md` (by hand) | **Not done** |
| G17 | Performance on staging within targets (20 people: 95th percentile under 2 s; a sale under 3 s) | `scripts/perf-baseline.ts`, `scripts/perf-pilot-calls.ts`, `scripts/perf-catalog.ts` (#71) against staging | Local only (`PILOT_PERFORMANCE_BASELINE.md`) |
| G19 | Documents match the product | `scripts/pilot-readiness-check.ts` (repository checks) | Done |
| G20 | A named support person, hours and a WhatsApp number; escalation path known | Runbook step 15 (by hand) | **Not done**: the owner names them |

**Tag rule.** Tag `v0.9.0-pilot` only when every gate passes. Until then the verdict cannot be READY. Never call the result production or general availability.
