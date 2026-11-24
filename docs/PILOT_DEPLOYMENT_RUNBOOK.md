# Pilot deployment runbook

Pilot readiness, item 22. How to take Bizora from `main` to a controlled pilot with a few Nigerian businesses, and how to run it day to day.

Run the steps in order. Each step says how you know it worked. Write what you saw, with the date and your name, in the step's **evidence** place. `scripts/pilot-readiness-check.ts` reads those places.

General deployment (Terraform, GitHub environments, rollback, logs) is in `docs/deployment.md`. This runbook adds what the pilot needs.

## 0. Before you start

- **Merge the readiness pull requests in this order:**
  1. #44 (email, tenant isolation, money integrity);
  2. #45 (offline and phones);
  3. #46 (switches, export, measures, sample business; migration 0039);
  4. this one (documents, checks, performance baseline).

  Each merge to `main` deploys staging.
  - After #44, the tenant isolation matrix checks every route.
  - If #46 merged first, add its new routes (`/api/v1/exports/business`, `/api/v1/telemetry/events`) to the matrix's route map.
- **Settings the deploy relies on:**
  - `INVITE_TOKEN_EXPOSE=false`: set by `deploy.yml` from #44, and in the staging `terraform.tfvars`.
  - `EMAIL_PROVIDER=resend` with a key in Secret Manager. Production refuses `console` from #44.
  - `TRUST_PROXY=true`.
  - `TRUST_PROXY_HOPS`: see step 4.

## 1. Staging is on the right version

```bash
gcloud run services describe bizora-api --project=bizora-staging --region=europe-west1 --format='value(spec.template.spec.containers[0].image)'
gcloud run jobs executions list --job=bizora-migrate --project=bizora-staging --region=europe-west1 --limit=3
```

**Worked when:**
- the image tag is the SHA of the last merge;
- the last migrate execution succeeded;
- `SELECT max(id) FROM schema_migrations` shows `0039_pilot_operations.sql` (Cloud SQL Studio, or the proxy).
- `SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'` returns a row (ADR-067). If it does not, the app's database user was not allowed to add it. Search still works, but slowly on big catalogs. Run `CREATE EXTENSION pg_trgm;` once as the `postgres` user in Cloud SQL Studio, then run the migrate job again: migration 0052 then adds the trigram indexes.

## 2. The repository checks pass

```bash
node --experimental-strip-types scripts/pilot-readiness-check.ts
```

**Worked when:** no FAIL. The MANUAL lines are the steps below.

## 3. Staging answers correctly

```bash
node --experimental-strip-types scripts/pilot-readiness-check.ts --url https://bizora-staging.baseportals.app --write
```

**Worked when** every live line passes:
- health;
- HTTPS-only header, content security policy and no-sniff header;
- signed-out requests refused;
- sign-up works;
- **invitation link not returned**;
- **sign-in limit holds against a forged `X-Forwarded-For`**.

`--write` signs up a throwaway business called "Readiness check …". Make it a sample business so it stays out of the measures (step 12), or remove it.

## 4. Rate limits see the person's real address (security review S-3)

Requests reach the API through the web service's rewrite. If the API trusts the wrong number of hops, every sign-in looks as if it came from the web service. Then either the whole country shares one limit, or anyone can forge a fresh allowance.

1. Step 3's last line must pass. If it fails, the forged address was trusted:
   1. set `TRUST_PROXY_HOPS` one lower and deploy again;
   2. if every attempt was limited at once, even the first, set it one higher;
   3. repeat step 3.
2. Sign in once from a phone on mobile data. Do the same from a second phone on a different network. The two `identity.login` rows in the activity log (`audit_events.ip`) must show the two phones' public addresses, not one Google address.

**Evidence:** write the hop count and the address seen in `docs/PILOT_SECURITY_REVIEW.md`, under S-3.

## 5. Backups exist

```bash
gcloud sql instances describe bizora-pg --project=bizora-staging --format='yaml(settings.backupConfiguration)'
gcloud sql backups list --instance=bizora-pg --project=bizora-staging --limit=7
```

**Worked when:**
- backups are enabled;
- a backup from the last 24 hours shows status SUCCESSFUL;
- for production, `pointInTimeRecoveryEnabled: true`.

**Evidence:** `docs/runbooks/restore.md`, under Backups: add "checked on DATE by NAME: last backup TIME".

## 6. Email reaches a real inbox

From staging, with a mailbox you can read on a phone (Gmail and a Nigerian provider if you can):

1. Sign up: the **confirm your email** message arrives, and its link works.
2. **Forgot password**: the reset message arrives; the link works once and not twice. After the reset, **password changed** arrives.
3. Invite a staff member: the **invitation** arrives, and its link opens the invitation.
4. Email a receipt from a sale (Sale › Email receipt): it arrives, and the link opens the receipt.
5. Open a support view in the Admin portal: the owner gets **Bizora support opened your records**.

**Worked when:** all five arrive within 2 minutes, not in spam, and the Resend dashboard shows them delivered.

**Evidence:** a line per message in `docs/PILOT_SECURITY_REVIEW.md`, under Email.

## 7. A restore works

```bash
bash docs/runbooks/restore-drill.sh bizora-staging
```

**Worked when:**
- the script prints the books balance, stock matches its movements, and the timings;
- the temporary instance is deleted.

**Evidence:** add a row to the drill log in `docs/runbooks/restore.md`, with the date, how long the restore took and the whole drill. Only then can the pilot say what the recovery time is.

**Recovery point and time.** Do not state a recovery point (RPO) or recovery time (RTO) to anyone until this drill has been run.

| | Staging | Production |
| --- | --- | --- |
| Recovery point, by design | Up to 24 hours (daily backup only) | About 5 minutes (point-in-time recovery) |
| Recovery time | Whatever the drill measures | The drill, plus switching the API (`restore.md`, step 4) |

The design figures follow from the backup settings. Neither has been measured yet.

## 8. Performance on staging

```bash
node --experimental-strip-types scripts/perf-baseline.ts https://bizora-staging.baseportals.app
```

**Worked when:**
- no errors;
- with 20 people, the 95th percentile is under 2 s for every call;
- recording a sale is under 3 s.

**Evidence:** add the tables to `docs/PILOT_PERFORMANCE_BASELINE.md`, under a "Staging" heading. Then make the filled business a sample (see step 12) and remove it.

For a pilot business with a large product list, also run the catalog check against staging (it makes up to 50,000 made-up products):

```bash
node --experimental-strip-types scripts/perf-catalog.ts https://bizora-staging.baseportals.app --sizes 1000,10000,50000
```

**Worked when:** searches are under 1 s at the 95th percentile at 50,000 products, and nothing fails.

## 9. Real Android phones

Follow `docs/PILOT_MOBILE_TEST_MATRIX.md` on at least 3 phones that pilot traders really use. Include one with 2 GB of memory or less, and one on Android 10 or older.

**Worked when:** every row of the matrix passes, or each failure has an issue and a way round it.

**Evidence:** a row per phone in the matrix's Results table, with **Flows passed** written as `11/11` (or how many passed), the problems found, the tester and the date.

## 10. Production (only when everything above passes)

Production is deployed by publishing a GitHub release, and needs a reviewer's approval.

1. Steps 1 to 9 must pass on staging, with their evidence written.
2. In `infra/terraform/envs/production`, check `invite_token_expose = false`, the email key secret and `alert_emails`. Then plan and apply.
3. Run `scripts/pilot-readiness-check.ts --url https://PRODUCTION` **without `--write`**.
4. Tag `v0.9.0-pilot` **only if** every gate in `docs/PILOT_READINESS_CHECKLIST.md` passes. Publish the release and approve the deploy.
5. Repeat step 4 (hops) and step 5 (backups, with point-in-time recovery) on production.

Never run `--write`, `perf-baseline.ts` or the sample business script against production.

## 11. Taking a pilot business on

1. The owner signs up on their own phone, accepting the Terms of use. Help them through the setup checklist on the home screen: products, shop address, first customer, staff, first sale.
2. In the Admin portal, open the business and check **Switches for this business**:
   - **Say a sale** stays on only if the owner wants to try it. It is experimental; tell them to check every number.
   - **Bizora AI photo reads** sends photos to Google Cloud. Switch it off if the owner does not want that.
   - **Support view** stays on so that support can help. The owner sees every look.
3. Show the owner **Settings › Download your records**, and agree how often they keep a copy.

For training and demonstrations, use a sample business, never a pilot business:

```bash
# On a machine that can reach the database (Cloud SQL proxy), with the API's environment:
pnpm --filter @bizora/api sample create --email trainer@yourdomain   # prints a password once
pnpm --filter @bizora/api sample list
pnpm --filter @bizora/api sample remove --yes                        # removes every sample business
```

## 12. Every day during the pilot

- **Admin portal › Pilot measures:**
  - businesses active;
  - sales and offline sales;
  - offline changes refused;
  - voice reviewed and confirmed;
  - voice downloads that failed.

  A business with refused changes or failed downloads needs a call.
- **A business's page › Last 7 days:**
  - refusal codes, voice problems;
  - signed-in sessions and shop phones;
  - last offline sync.
- **Errors:** Error Reporting for `bizora-api` and `bizora-web-browser`. Search Cloud Logging by the business's ID or by the support code a trader reads out: the first 8 characters of the correlation ID.
- **Alerts:** `docs/runbooks/incidents.md`.
- **Make a business a sample** (excluded from the measures, removable), in Cloud SQL Studio: `UPDATE organizations SET is_sample = true WHERE id = '…'`. Do this only for test businesses, never a trader's.

## 13. When something goes wrong

- **A feature misbehaves for one business.** Switch it off for that business (step 11) with the reason. The owner sees it.
- **A bad deploy.** Roll back the Cloud Run revision (`docs/deployment.md`, Rollback). Migrations are forward-only.
- **Damaged data.** `docs/runbooks/restore.md`, "When something has gone wrong". Stop writes first.
- **A trader's phone holds unsent sales.** The badge shows how many. Tapping it sends them now. A refused sale is named on the screen with the reason and is kept until someone deals with it. Nothing on the phone is deleted by Bizora.

## 14. Ending the pilot, or a business leaving it

1. The owner downloads their records (Settings › Download your records).
2. If the account is to be closed, follow the Terms (section 9) and the law on keeping records.
