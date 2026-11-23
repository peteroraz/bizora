# Pilot readiness checklist

Pilot readiness, item 2. Every gate must pass before `v0.9.0-pilot` is tagged (item 30).

- **Automated gates:** `node --experimental-strip-types scripts/pilot-readiness-check.ts` checks the repository, and `--url … --write` checks staging.
- **People-only gates:** these pass only when their evidence is written where the gate says.
- **Status:** the status in this table is as of 23 Nov 2026, with #44, #45 and #46 open. The current state of every item is in `docs/PILOT_READINESS_STATUS.md`, and the verdict in `docs/PILOT_READINESS_REPORT.md`.

| # | Gate | How it is checked | Status |
| --- | --- | --- | --- |
| G1 | CI green on `main`: lint, typecheck, unit tests, build, `pnpm audit --prod`, Gitleaks, Terraform | GitHub checks on the last commit of `main` | Each open PR green on its own; `main` after all four merges not yet |
| G2 | Browser tests (E2E) green | CI `e2e` job | Green on #44, #45 and #46 |
| G3 | Tenant isolation matrix passes and covers every route | `tenant-matrix.test.ts`, in CI (#44) | Passes on #44. New routes from #46 must be added after both merge. |
| G4 | Money integrity suite passes | `financial-integrity.test.ts`, in CI (#44) | Passes on #44 |
| G5 | No unresolved Critical or High security finding | `docs/PILOT_SECURITY_REVIEW.md` | No Critical or High in code; S-3 (Medium) needs staging |
| G6 | Invitation links are not returned by the API on staging or production | Readiness check `--url … --write` | Settings in #44; not yet checked on staging |
| G7 | Sign-in limits count the real client address (S-3) | Readiness check `--write`; runbook step 4 | **Not checked**: no staging access from this session |
| G8 | Email reaches a real inbox: confirm email, reset, password changed, invitation, receipt, support notice | Runbook step 6, logged in the security review | **Not checked** |
| G9 | Backups present; point-in-time recovery on in production | Runbook step 5, logged in `restore.md` | **Not checked** |
| G10 | A restore drill has been run and logged | `docs/runbooks/restore.md` drill log | **Not done**: the log is empty |
| G11 | Offline: sales kept through failures, reloads and tabs, sent once, kept in their shop | `offline-hardening.e2e.ts` (#45) | Passes in the browser; not yet on a real phone |
| G12 | Android: at least 3 real phones pass the matrix, including one with 2 GB of memory or less | `docs/PILOT_MOBILE_TEST_MATRIX.md` | **Not done** |
| G13 | Voice is experimental, reviewed before saving, typed fallback offered, switchable per business | ADR-044, ADR-045, `docs/voice/README.md` | Done (#45, #46) |
| G14 | No external payment gateway; no AI agents | Code search; payment switch locked off (#46) | Done |
| G15 | Owners can download their records | `pilot-operations.test.ts`, `pilot-operations.e2e.ts` (#46) | Done |
| G16 | Pilot measures and support tools in the Admin portal | ADR-045 (#46) | Done |
| G17 | Performance on staging within targets (20 people: 95th percentile under 2 s, a sale under 3 s) | Runbook step 8 | Local baseline only (`PILOT_PERFORMANCE_BASELINE.md`) |
| G18 | Pilot terms and privacy wording reviewed | `docs/PILOT_TERMS_AND_PRIVACY.md` | Privacy updated; the pilot section of the terms waits for counsel |
| G19 | Documents match the product | README, architecture, deployment, this folder | Done in this PR |

**Tag rule.** Tag `v0.9.0-pilot` only when G1 to G19 all pass. Until then no tag is made and the verdict cannot be READY. Never call the result production or general availability.
