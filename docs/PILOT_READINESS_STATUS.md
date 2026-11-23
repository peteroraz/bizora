# Pilot readiness status

Status of every item in the pre-pilot readiness sprint, as of **23 Nov 2026**.

**Pull requests.** The work is in four pull requests against `main`, all opened by Claude and waiting for review and merge:

| PR | What it holds |
| --- | --- |
| #44 | A: email delivery, tenant isolation matrix, money integrity, idempotency, security review (ADR-042, ADR-043) |
| #45 | B: offline, small screens, low bandwidth, voice pilot status (ADR-044) |
| #46 | C: business switches, records export, pilot measures, sample business, error wording (ADR-045) |
| this PR | D: documents, readiness checks, performance baseline, a deadlock fix |

Until they merge, `main` does not have their work.

**Classifications.**

| Classification | Meaning |
| --- | --- |
| **IMPLEMENTED** | Built and tested in code. |
| **NEEDS PILOT VALIDATION** | Built and tested, but only real use can prove it: real phones, real speech, a real inbox, staging. |
| **PARTIAL** | Some of it is done; what is missing is stated. |
| **NOT IMPLEMENTED** | Not built. The reason and how it is handled are stated. |
| **NOT REQUIRED** | Deliberately not built for the pilot. |

| # | Item | Status | Where | What is true |
| --- | --- | --- | --- | --- |
| 1 | Documents match the product | IMPLEMENTED | this PR | README, architecture overview, deployment guide and the specification pointer no longer say sales, payments or email are missing; new pilot documents in `docs/`. |
| 2 | Readiness checklist and check script | IMPLEMENTED | this PR | `PILOT_READINESS_CHECKLIST.md` (gates G1–G19); `scripts/pilot-readiness-check.ts` checks the repository and, with `--url`, a running environment. |
| 3 | Email provider, production-ready | IMPLEMENTED · NEEDS PILOT VALIDATION | #44 | Details below the table. |
| 4 | Password reset | IMPLEMENTED · NEEDS PILOT VALIDATION | existing + #44 | Single-use link that expires in 30 minutes; every session is signed out on reset; "password changed" email (#44). Delivery to a real inbox not yet checked. |
| 5 | PostgreSQL row-level security | NOT IMPLEMENTED (formally gated) | #44, ADR-043, issue #43 | Details below the table. |
| 6 | Tenant isolation matrix, blocking in CI | IMPLEMENTED | #44 | Details below the table. |
| 7 | Financial integrity suite | IMPLEMENTED | #44 | Sales, returns, debt payments, POS cash-out, non-sales money never counted as profit, double submits and racing requests, and a 40-step mixed run; the books balance after each. |
| 8 | Idempotency | IMPLEMENTED | existing + #44 | Every offline operation uses its device ID as the key. #44 adds the `idempotency-key` header to the voids, approvals, rejections and cancellations that lacked it. |
| 9 | Offline hardening | IMPLEMENTED · NEEDS PILOT VALIDATION | #45 | Details below the table. |
| 10 | Voice | IMPLEMENTED · NEEDS PILOT VALIDATION | #45, #46 | Details below the table. |
| 11 | Android device matrix and fixes | PARTIAL | #45 | Done: 13 screens checked at 320 and 360 px for sideways scrolling and for controls under 40 px; tap targets fixed. **Not done:** real phones (`PILOT_MOBILE_TEST_MATRIX.md` lists them). |
| 12 | Low bandwidth | IMPLEMENTED · NEEDS PILOT VALIDATION | #45 | Voice download shows its size, progress, Stop, Retry, and can be removed in Settings. Quick sale script budget is 170 KB (169.8–169.9 used), enforced in CI. Not measured on real 3G. |
| 13 | Upload and storage safety | IMPLEMENTED | existing | Details below the table. |
| 14 | Business data export; backup and restore | PARTIAL | #46 | **Export done:** a ZIP of CSV files, owner and administrators, audited. **Backups:** documented (`restore.md`). **Restore drill: never run**, so no recovery point (RPO) or recovery time (RTO) is stated as fact. |
| 15 | Support access audit tests | IMPLEMENTED | existing + #44 | Every support view needs a reason, lasts an hour, is read-only, is logged for staff and owner, and emails the owner (#44). Tests cover each. |
| 16 | Admin portal hardening tests | IMPLEMENTED | existing + #44 | Google sign-in with PKCE and nonce; staff list; roles per ability; a header check against other sites; forged and tampered session cookies refused (#44). |
| 17 | Pilot telemetry and measures | IMPLEMENTED (gaps stated) | #46 | `pilot_events` keeps names and short codes only. Admin portal: Pilot measures page, and Last 7 days per business. Gap: voice downloads from Settings are not counted yet. |
| 18 | Feature switches per business | IMPLEMENTED | #46 | Offline voice, photo reads, support view; advanced accounting and payment gateways locked off in the API and the database. |
| 19 | Demo or seed data | IMPLEMENTED | #46 | `sample create / list / remove`; marked everywhere; left out of the measures. Only a sample's records can be deleted, and only by the script. |
| 20 | Onboarding in business language | IMPLEMENTED | existing | Home screen setup checklist: products, shop address, first customer, staff, first sale, each with a link. |
| 21 | User-facing error messages | IMPLEMENTED | #46 | Framework messages replaced with plain words; a support code on server faults; messages written for people kept. |
| 22 | Staging validation and deployment runbook | PARTIAL | this PR | **Runbook written** (`PILOT_DEPLOYMENT_RUNBOOK.md`). **Staging not validated:** this session has no Google Cloud access, and its network cannot reach staging. Runbook steps 1–9 are for the team. |
| 23 | No external payment gateways | IMPLEMENTED (by design) | #46 | None exist; payments are recorded as cash, transfer or POS. The switch is locked off. |
| 24 | No AI agents | NOT REQUIRED (confirmed absent) | existing | No agent acts on anyone's behalf. Photo reads and voice only fill drafts that a person checks and confirms. "Ask Zora" is not built. |
| 25 | Pilot terms and privacy | PARTIAL | this PR | Privacy notice updated (measures, export). Proposed pilot section for the Terms of use in `PILOT_TERMS_AND_PRIVACY.md`, waiting for counsel. Adding it needs a new terms version. |
| 26 | Security review | IMPLEMENTED | #44 | `PILOT_SECURITY_REVIEW.md`: no unresolved Critical or High finding in code; S-3 (Medium) needs a staging check. |
| 27 | Dependency and supply-chain review | IMPLEMENTED | this PR | Details below the table. |
| 28 | Performance baseline (20 and 50 people, 5,000 customers, 10,000 sales) | PARTIAL | this PR | Details below the table. |
| 29 | Support tooling | IMPLEMENTED | #46 + existing | Admin portal: find a business or person, resend invitations and verification, sign out everywhere, stop a phone, support view, limits, switches, Last 7 days (refusals, voice problems, sessions, last sync). |
| 30 | Tag `v0.9.0-pilot` | NOT DONE (gates not met) | — | Gates G7–G10, G12 and G17 need staging, Google Cloud or real phones. No tag. |

## Details

**3. Email provider.** `EmailPort` with Resend and console adapters.
- Each send is retried up to 3 times on 429, 5xx and network errors, with one idempotency key per send.
- Addresses are masked and tokens hidden in logs.
- Production refuses the console provider and invitation links in replies.
- Not yet checked: delivery to a real inbox from staging (runbook step 6).

**5. Row-level security.** Not built. One shared connection pool serves 48 services, and public receipts, the Admin portal and sign-in all need paths around row-level security.
- **Instead:** a blocking matrix probes every route as another business and fingerprints every business table before and after.
- **Status:** blocking before general availability, not before the pilot.

**6. Tenant isolation matrix.** Every route is probed as another business.
- The data of every table with `tenant_id` is fingerprinted, so a change to the other business fails the test.
- A route coverage gate fails when a route is added without a probe.
- Three probes stop at validation (product photos, product edit, job lines). Their services filter by tenant; this is recorded in ADR-043.

**9. Offline hardening.** Fixed:
- a sale moved to another shop at sync time;
- customer search needed the internet, so credit sales could not be made offline;
- a failed sync was invisible;
- tabs disagreed after one synced.

Browser tests cover reload, a new tab, two tabs and a refused sale. Not tried on real phones.

**10. Voice.**
- **Done:**
  - the benchmark scores the sale read from speech, not just words wrong, with Pidgin-influenced, fast and slow sets;
  - review is mandatory and nothing is ever saved by itself;
  - every review says to check the numbers;
  - typing is the fallback;
  - requirements are documented;
  - voice can be switched off per business.
- **Not proven:**
  - real Nigerian market speech;
  - false confidence is 22–36% on clean recordings, which is why review stays mandatory.

**13. Upload and storage safety.**
- Product photos and logos must be real PNG or JPEG (checked by their header, never SVG), within byte, pixel and count limits.
- They are stored in Postgres, not a public bucket, and served with `nosniff`.
- Photos for capture are limited by type, count and size, and are not stored.
- Request bodies are size-limited per route.
- Files are not re-encoded or virus-scanned.

**27. Dependency and supply-chain review.** `PILOT_DEPENDENCY_REVIEW.md`:
- `pnpm audit --prod` passes, with one ignore and its ADR;
- 4 moderate advisories, in development tools only;
- licences reviewed, none GPL or AGPL;
- Gitleaks;
- pinned voice models.

**28. Performance baseline.** Measured locally, not on staging (`PILOT_PERFORMANCE_BASELINE.md`).
- No errors.
- Each call takes 6–55 ms on its own.
- Under 50 people in one business, the 2-CPU machine was the limit.
- Found and fixed a deadlock when a new business's first products were added at once.
- Staging run: runbook step 8.
