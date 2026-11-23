# Bizora pilot readiness report

23 Nov 2026. Covers the pre-pilot readiness sprint (items 1–30). Item by item: `docs/PILOT_READINESS_STATUS.md`. Gates: `docs/PILOT_READINESS_CHECKLIST.md`.

## 1. Verdict

**READY WITH CONDITIONS** for a controlled pilot with a few Nigerian businesses. **Not tagged** `v0.9.0-pilot`.

- **The code is ready.** Every engineering item is built and tested, except row-level security, which is formally gated before general availability.
- **No Critical or High issue is open in code.**
- **What is not ready is evidence.** The following need Google Cloud access, staging or real phones, none of which this work had:
  - staging checks;
  - email to a real inbox;
  - a restore drill;
  - backups confirmed;
  - real Android phones;
  - performance on staging.

  Section 14 lists them. Until they pass, do not invite the first pilot business and do not tag.

This is a pilot. It is not production general availability, and Bizora holds no security or data protection certification.

## 2. Scope

**In scope:** the 30 items of the readiness brief: reliability, safety, measurement, deployment and support for a pilot.

**Out of scope by the brief's own rules:**
- new features;
- payment gateways;
- AI agents;
- rewriting working architecture.

Nothing speculative was added. Where an item asked for something that does not exist (advanced accounting, payment gateways), it is a switch locked off, not a feature.

## 3. Where the work is

Four pull requests against `main`, each independent and each green in CI when opened:

| PR | Area | ADRs | Migration |
| --- | --- | --- | --- |
| #44 | Email delivery, tenant isolation matrix, money integrity, idempotency on voids and approvals, security review | ADR-042, ADR-043 | none |
| #45 | Offline hardening, small screens, voice download control, voice pilot status, mobile test matrix | ADR-044 | none |
| #46 | Switches per business, records export, pilot measures, support panel, sample business, plain error words | ADR-045 | 0039 |
| #47 | Documents, readiness check script, performance baseline, deadlock fix | none | none |

- **Merge order:** #44, #45, #46, then #47. Each merge deploys staging.
- **After both #44 and #46 are in:** add #46's two new routes to the isolation matrix's route map; its coverage gate will name them.

## 4. What changed, by area

| Area | Before | Now |
| --- | --- | --- |
| Email | One attempt; addresses in logs; console allowed everywhere | Retries with an idempotency key; masked logs; production refuses console |
| Invitations on staging | The API returned the link | Not returned (deploy and Terraform) |
| Tenant isolation | Tests for key routes | Every route probed as another business; every tenant table fingerprinted; coverage gate |
| Money | Tests per feature | One integrity suite: every money path, double submits, races, a 40-step mixed run; books balance throughout |
| Offline | Worked on the happy path | Sales keep their shop; offline customer search and credit sales; sync status, retry and refusals shown; tabs agree |
| Phones | Desktop-first checks | 13 screens at 320 and 360 px; tap targets of 44 px or more |
| Voice | Measured on words wrong | Measured on the sale read; check-the-numbers notice; Stop and Retry on download; switch per business |
| Operations | None | Switches, records export, pilot measures, Last 7 days support panel, sample business |
| Errors | Framework messages | Plain words, and a support code on server faults |
| Documents | Said sales, payments and email did not exist | Match the product; pilot documents added |

## 5. Real problems found and fixed

These were bugs, not hypotheses. Each has a test.

1. **An offline sale could move to another shop.** It was booked in whichever shop was selected when it synced (#45).
2. **No credit sales offline.** Customer search needed the internet (#45).
3. **A failed sync was invisible to the trader** (#45).
4. **Two tabs disagreed** after one synced (#45).
5. **Follow-ups answered 200 for another business's customer** (#44). Empty, but it should have been refused.
6. **Invitation links were returned by the API on staging** (#44).
7. **Sign-in and reset tokens could appear in console logs** (#44).
8. **A deadlock when a new business's first products were added at once**: 4 of 5 failed (#47). Found by the performance baseline, fixed with an advisory lock, and covered by a real-Postgres browser test.
9. **Measures queries failed on real Postgres** (#46): the driver does not take JavaScript dates in raw SQL. Caught before merge by running the queries against Postgres; PGlite had passed them.
10. **Framework messages shown to traders** (#46). For example "ThrottlerException: Too Many Requests", and "Request validation failed." in the list of refused offline sales.

## 6. Test execution

Measured in this sprint:

| Suite | Result |
| --- | --- |
| API unit and integration tests (Vitest, PGlite) | #46 branch: 294 passed in 48 files. `main` with #47: 280 in 46 files. |
| Contracts and web unit tests | Passed on every branch (contracts 91, web 47 on #45) |
| Web browser tests (Playwright, real Postgres) | #46: 34 passed. This PR: 34 passed. #45: 36 passed, with one known flaky test (shop mode) that passes on retry. |
| Admin portal browser tests | #46: 2 passed |
| Lint, typecheck, build | Passed on every branch (35 to 40 turbo tasks) |
| `pnpm audit --prod` | Passes (one ignore, with its ADR) |
| CI (verify, e2e, docker, terraform) | Green on #44, #45 and #46 |
| Quick sale script budget | 169.8–169.9 KB of 170 KB |

**Known flaky tests:**
- `shop-mode.e2e.ts` ("Staff added." not visible in time);
- sprint-7i and terms tests in full runs.

All pass on retry. They are timing-sensitive tests, not product faults, but they should be steadied.

## 7. Security

`docs/PILOT_SECURITY_REVIEW.md` (#44):

- **No unresolved Critical or High finding in code.**
- **S-3 (Medium):** whether sign-in limits see the person's real address through the web service's rewrite. It needs a staging check (runbook step 4, and `pilot-readiness-check.ts --write`).
- **Done in this sprint:**
  - forged and tampered admin cookies are refused;
  - support access is read-only, takes a reason, lasts an hour and emails the owner;
  - switch changes are logged for staff and owner;
  - the records export leaves out secrets, links and sign-in addresses, and is formula-safe;
  - pilot measures hold no personal data, enforced in the API and the database.
- **Dependencies:** `docs/PILOT_DEPENDENCY_REVIEW.md`.

## 8. Tenant isolation

- **Row-level security: not implemented.** It is gated before general availability (ADR-043, issue #43), because 48 services share one pool and public receipts, the Admin portal and sign-in need bypass paths.
- **Instead, and blocking in CI:**
  - every route is probed as another business;
  - every table with `tenant_id` is fingerprinted before and after;
  - a coverage gate fails when a route has no probe.
- **Three probes** stop at validation (product photos, product edit, job lines). Their services filter by tenant, as ADR-043 records.

## 9. Money integrity

- Amounts are `bigint` minor units throughout, and are exported as whole numbers.
- **The suite (#44):**
  - checks sales, returns, debt payments, POS cash-out, and non-sales money never counted as profit;
  - sends double submits and racing requests;
  - runs a 40-step mixed sequence;
  - checks the books balance after each.
- Journal entries, stock movements and returns stay unchangeable in the database. The single exception is deleting a sample business's rows with its removal script, tested to refuse real businesses' rows (#46).

## 10. Offline, phones and low bandwidth

- **Browser tests (#45):**
  - a sale survives a failed sync, a reload, a new tab and two tabs, and is sent once;
  - it keeps its shop;
  - a refused credit sale is named on screen;
  - customer search works offline.
- **Small screens:** 13 screens at 320 and 360 px, with no sideways scrolling and controls of 40 px or more.
- **Low bandwidth:**
  - the voice download shows its size, can be stopped and retried, and can be removed in Settings;
  - the quick sale script budget is enforced.
- **Not done:** real Android phones (`docs/PILOT_MOBILE_TEST_MATRIX.md`, Results table empty), and real 3G.

## 11. Voice

**Status: experimental.** It can be switched off per business.

- **Benchmark round 3** (`docs/voice/benchmark.md`) scores the sale read, not just words, with Pidgin-influenced, fast and slow sets.
  - Best accuracy read 19 of 36 clean sales fully right, and 10 of 24 Pidgin-influenced, fast and slow ones.
  - **False confidence is 22–36%** on clean recordings: a wrong sale that looks complete.
- **So:**
  - review before confirming is mandatory;
  - every review says to check the numbers;
  - nothing is ever saved by itself;
  - typing is always offered.
- **Not proven:** real market speech in Nigeria, and real phones' memory.

## 12. Email, backups and restore

- **Email (ADR-042):** ready in code. Not yet seen arriving in a real inbox from staging (runbook step 6).
- **Backups:** configured in Terraform (daily; point-in-time recovery in production). Not yet confirmed in Google Cloud (runbook step 5).
- **Restore:** a runbook and a drill script exist, but **the drill has never been run**. No recovery time is stated. The recovery point, by design: about 5 minutes in production, up to 24 hours on staging.
- **Records export:** owners can download every record at any time. It is a copy for the owner, not a backup.

## 13. Performance and dependencies

**Local baseline** (`docs/PILOT_PERFORMANCE_BASELINE.md`): one business with 5,000 customers and 10,000 sales, on a 2-CPU machine.

| Measure | Result |
| --- | --- |
| Errors | None |
| Each call on its own | 6 to 55 ms |
| 20 people at once, 95th percentile | 0.5–0.9 s for reads; 1.6 s to record a sale |
| 50 people at once | The machine's CPU was the limit: home screen about 3 s, a sale up to 4 s at the 95th percentile |

Staging has not been measured.

**Dependencies:**
- 367 production packages;
- no GPL or AGPL;
- one ignored advisory, with its ADR;
- 4 moderate advisories, in development tools only;
- lockfile frozen;
- Gitleaks;
- pinned voice models.

## 14. Conditions before the first pilot business

**Blocking**, each a gate in the checklist and a runbook step:

| # | Condition | Gate | Runbook step |
| --- | --- | --- | --- |
| C1 | Merge #44, #45, #46 and #47; `main` green; add #46's routes to the isolation matrix | G1–G3 | 0 |
| C2 | Staging passes `pilot-readiness-check.ts --url … --write` | G6 | 3 |
| C3 | S-3: sign-in limits see real addresses | G7 | 4 |
| C4 | Backups confirmed in Google Cloud | G9 | 5 |
| C5 | Email arrives in a real inbox: all six messages | G8 | 6 |
| C6 | Restore drill run and logged | G10 | 7 |
| C7 | 3 real Android phones pass the matrix, one with 2 GB of memory or less | G12 | 9 |
| C8 | Performance on staging within targets | G17 | 8 |

**Not blocking the pilot, but before general availability:**
- PostgreSQL row-level security (issue #43);
- the pilot section of the Terms of use, after counsel;
- upgrade vitest;
- remove the picomatch audit ignore;
- container image scanning;
- steady the flaky tests;
- count voice downloads from Settings.

**Known risks, accepted for the pilot:**

- **Voice can be confidently wrong.** Review is mandatory; voice is switchable per business.
- **Phone measures are lost** when a page closes offline, so the measures undercount.
- **Two other places lock a parent row** like the deadlock fixed here: a cash count on a shop, and adding a shop phone. Both are rare and done by one person. Change them the same way if a deadlock is ever logged.
- **No rows are ever deleted for real businesses.** A wrong record is reversed, never removed. This is by design.

## 15. Tag decision and what not to say

**Tag:** `v0.9.0-pilot` is **not created**. The rule (item 30) is that every gate passes. Gates G7–G10, G12 and G17 have no evidence yet, and #44–#46 are not merged. When the conditions in section 14 are met, the person who checked them tags it (runbook step 10) and changes the verdict here to READY.

**Do not say,** in the app, on the website, in emails or to traders:
- that Bizora is production-ready, generally available or launched;
- that it holds any certification it does not have (ISO 27001, SOC 2, or anything else);
- that voice understands Pidgin, Hausa, Yoruba or Igbo;
- that backups have been restored, or what the recovery time is, before the drill;
- that card or online payments are accepted.
