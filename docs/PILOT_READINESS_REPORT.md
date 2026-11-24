# Bizora pilot readiness report

**24 Nov 2026.** Everything on `main` up to #57, and the open pull requests #58–#72.

Related documents:
- `docs/PILOT_READINESS_STATUS.md`: every capability, item by item;
- `docs/PILOT_READINESS_CHECKLIST.md`: the gates, with their tests;
- `docs/PILOT_DEPLOYMENT_RUNBOOK.md`: how each gate is checked on staging.

This is a pilot with a few businesses. It is **not** production general availability. Bizora holds no security or data protection certification.

## 1. Executive summary

**Verdict: READY WITH CONDITIONS** for a controlled pilot with a small number of businesses. **Not READY.** `v0.9.0-pilot` is **not tagged**.

- **The code is ready for a pilot once the open fixes are merged.** Every engineering item of the readiness brief is built and tested, except row-level security (formally gated before general availability).
- **One serious bug is fixed but not yet merged:** service businesses that changed type could not save sales, because the books had no service income account (#59). The verdict cannot become READY until it is on `main` and deployed (section 15, B1).
- **What is not ready is evidence that needs Google Cloud, staging or real phones:**
  - staging checks;
  - email arriving in a real inbox;
  - backups confirmed;
  - a restore drill;
  - three real Android phones;
  - performance on staging.

  None of these could be done from where this work was done. Section 15 lists them.
- **Do not invite the first pilot business** until the blockers in section 15 are cleared.

## 2. Completed work

**On `main` and deployed to staging:**

| PRs | What |
| --- | --- |
| #44–#47 | Pilot readiness: email delivery and isolation matrix (ADR-042, ADR-043); offline hardening and small screens (ADR-044); switches, records export, measures, support panel (ADR-045); documents and performance baseline |
| #48, #51 | Inventory phases 2–4: catalog items and variants, categories, brands, codes (ADR-046); warehouses, transfers with a lifecycle, count sessions (ADR-047); price lists, supplier products, landed cost (ADR-048) |
| #52–#53 | Record a sale before products are set up; quick catalog (ADR-049) |
| #54–#57 | Offline sales always kept, with "Sales that need you" (ADR-050); profit always shown (ADR-051); typed names matched to products (ADR-052); custom units, old typed lines, cash-out warning (ADR-053) |

**Open and waiting to be merged** (CI green, or re-running; merge order in section 15):

| PR | What | ADR |
| --- | --- | --- |
| #58 | "Paid in full" removed from receipts and invoices | ADR-054 |
| #59 | Missing book accounts added when a business changes type (the VIGOTECH error) | ADR-055 |
| #60 | Warehouses have no cash drawer; delivery charges paid from a shop's cash or the bank | ADR-056 |
| #61 | Several sales in one recording; "Read this as a sale" | ADR-057 |
| #62 | Sales report by week, month or year | ADR-058 |
| #63 | Return time limit; standard credit terms | ADR-059 |
| #64–#67 | Inventory phase 5: attributes, batches and expiry, serials and IMEIs, reorder rules | ADR-060 to ADR-063 |
| #68–#72 | Inventory phase 6: offline products and counts, product files, camera scanning, trigram search and the 50,000-product check, phone polish and the inventory status | ADR-064 to ADR-067 |
| this PR | This report, status, checklist, Terms pilot section (version 2026-11-24), privacy, performance and support escalation | ADR-068 |

## 3. Security findings and fixes

`docs/PILOT_SECURITY_REVIEW.md`:

- **No unresolved Critical or High finding in code.**
- **Fixed during the readiness work:**
  - follow-ups answered 200 for another business's customer (empty, but should have been refused);
  - invitation links were returned by the API on staging;
  - sign-in and reset tokens could appear in console logs;
  - forged and tampered admin cookies are now refused.

  Each has a test.
- **Support access:** read-only, needs a reason, lasts an hour, emails the owner, and every look is logged for staff and the owner.
- **Tenant isolation:**
  - **Row-level security is not implemented.** It is gated before general availability (ADR-043, issue #43).
  - **Instead, blocking in CI:** every route is probed as another business, every table with `tenant_id` is fingerprinted, and a coverage gate fails when a new route has no probe. Every new `:id` route in #58–#72 was added to the matrix, and each new feature has its own cross-business test.
- **Open (Medium), S-3:** whether sign-in limits see the person's real address behind the web service's rewrite. It needs a staging check (B4).
- **Dependencies:** `docs/PILOT_DEPENDENCY_REVIEW.md`:
  - `pnpm audit --prod` passes with one documented ignore;
  - no GPL or AGPL;
  - Gitleaks in CI;
  - voice models pinned by hash.

## 4. Financial integrity findings

- **The suite** (`financial-integrity.test.ts`):
  - covers sales, returns, debt payments, POS cash-out, and non-sales money never counted as profit;
  - sends double submits and racing requests;
  - runs a 40-step mixed sequence;
  - checks the books balance after each step.
- Money is `bigint` minor units everywhere, and quantities are thousandths. Journal entries, stock movements and returns cannot be changed in the database.
- **Found and fixed since the first report:**
  - **Service income account missing** after a business changes type, so sales could not be saved (#59, open). Accounts are now added for the new type, and onboarding repairs them.
  - **"Paid in full. Thank you for your custom."** was printed on every receipt and invoice, including unpaid ones (#58, open).
  - **Warehouses had no cash drawer of their own**, so a delivery charge paid in cash at a warehouse had nowhere to come from. Cash now comes from a chosen shop's drawer or the bank (#60, open). Other cash paths at a warehouse (a supplier's cash refund, an expense) still need a shop's drawer, and say so in plain words.
  - **An uneven "for all" amount said in a sale** could be split into a slightly different total (549,999 for 550,000). The exact total is kept (#61, open).
  - **Profit was hidden in some cases.** It is now always shown (#55, merged).
- **New money paths in phase 5 post nothing.** Batches, serials, attributes and reorder rules hold quantities and links only. Stock value stays the weighted average, and the integrity suite still passes on each branch.

## 5. Offline findings

- **Fixed earlier (#45):**
  - a sale moved to another shop at sync time;
  - credit sales were impossible offline;
  - a failed sync was invisible;
  - two tabs disagreed.
- **Since then:**
  - **Offline sales are never discarded** (#54). A sale whose price, credit or shop changed before it synced is kept and listed under "Sales that need you".
  - A sale more than 7 days old is refused (`TOO_OLD`) but kept for the owner.
- **Added in #68 (open):**
  - new products, take off / add back stock, and count lines can be saved offline;
  - a count made offline is compared with the stock at the time it was counted, not when it arrived;
  - a phone's clock is believed for at most a week back.
- **Batches (#65) and serials (#66):**
  - a counter sale is refused on expired stock or a serial already sold;
  - an offline sale is kept in both cases, and the owner is told.
- **Tested in the browser** with the network really off (`offline.e2e.ts`, `offline-hardening.e2e.ts`, `offline-stock.e2e.ts`). **Not yet tested on real phones.**

## 6. Mobile findings

- **Every screen is checked at 320 and 360 px** (`mobile-layout.e2e.ts`): no sideways scrolling, and controls of 40 px or more.
- **New e2e tests run at 360 px.** All phase 5 and 6 e2e tests use a 360 px phone.
- **#72 (open) fixed the stock screens:**
  - 11 action buttons pushed the search off the screen; they are now one sideways-scrolling row with Add item first;
  - cards have 16 px padding on phones;
  - "All shops" showed "No products yet"; it now asks for a shop;
  - two links were 20 px tall; they are now 44 px.
- **Quick sale JavaScript:** 159–160 kB of its 170 kB budget, checked in CI. Camera scanning loads only when tapped.
- **Not done:** three real Android phones, one with 2 GB of memory or less (`PILOT_MOBILE_TEST_MATRIX.md`, results table empty), and a real 3G connection.

## 7. Voice findings

**Status: experimental.** It can be switched off per business.

- **Benchmark round 3** (`docs/voice/benchmark.md`) scores the whole sale read, not just the words:
  - Best accuracy read 19 of 36 clean sales fully right;
  - it read 10 of 24 Pidgin-influenced, fast and slow sales fully right;
  - **false confidence is 22–36%** on clean recordings: a wrong sale that looks complete.
- **So:**
  - review before confirming is mandatory;
  - every review says to check the numbers;
  - nothing is ever saved by itself;
  - typing is always offered.
- **#61 (open):** several sales in one recording, each reviewed and saved on its own. "Read this as a sale" turns typed text into a sale the same way. An uneven "for all" amount keeps its exact total.
- **Speech is turned into words on the phone.** The recording never leaves the phone. The new privacy paragraph and Terms section 13 say so.
- **Not proven:** real market speech in Nigeria, real phones' memory, and any language other than English. None is claimed.

## 8. Deployment status

- **Staging** (`bizora-staging.baseportals.app`, Google Cloud `bizora-staging`, europe-west1) runs `main` up to #57. Each merge to `main` deploys staging, with migrations run by the `bizora-migrate` job.
- **Open PRs add migrations:**
  - 0047 (returns and credit terms, #63);
  - 0048 (attributes, #64);
  - 0049 (batches, #65);
  - 0050 (serials, #66);
  - 0051 (reorder rules, #67);
  - 0052 (trigram search, #71).

  They only add tables, columns and indexes. Migration 0052 needs the `pg_trgm` extension. If the database user may not add it, search still works, and runbook step 1 says how an administrator adds it.
- **Production:** not set up for the pilot. The domain, email sender, Google sign-in and AI are configured for staging only. Production is runbook step 10, after every gate passes.
- **Staging has not been validated** by the readiness checks. This work had no Google Cloud access, and staging was not reachable from where it ran.

## 9. Backup/restore status

- **Backups:** configured in Terraform: daily, with point-in-time recovery in production. **Not yet confirmed in Google Cloud** (B5).
- **Restore:** a runbook and a drill script exist (`docs/runbooks/restore.md`, `restore-drill.sh`). **The drill has never been run** (B7), so no recovery time is stated.
- **Recovery point, by design:** about 5 minutes in production, and up to 24 hours on staging. It is not proven.
- **Records export:** owners can download every record at any time, as a ZIP of CSV files. It is a copy for the owner, not a backup. Terms section 13 tells owners to keep their own copy.

## 10. Email status

- **Ready in code (ADR-042):**
  - Resend adapter, with retries and one idempotency key per send;
  - masked addresses and hidden tokens in logs;
  - production refuses the console provider.
- **Six messages:** confirm email, password reset, password changed, invitation, receipt, and support notice.
- **Not yet seen arriving in a real inbox from staging** (B6). The production sender domain is not set up.

## 11. Known limitations

- **Tenant isolation** is enforced in code and tested in CI, not by row-level security.
- **Offline:**
  - expenses, money moves, cash counts, supplier payments, returns, jobs and photos need the network;
  - sales older than 7 days are refused at sync, but kept for the owner;
  - a phone's first product download is large for very large catalogs (29 MB at 50,000 products).
- **Inventory:**
  - no reservations, incoming stock or purchase orders;
  - no batch costing;
  - serials are not named on transfers;
  - product files do not yet carry batch, expiry or serial columns;
  - online and tax fields can be set through the API only (`docs/INVENTORY_IMPLEMENTATION_STATUS.md`, #72).
- **Voice:** English only; confidently wrong in up to a third of clean recordings; review is mandatory.
- **Scanning:** only where the browser has a barcode reader (Chrome on Android); not Safari on iPhone.
- **Onboarding:** there is no payment-methods step and no tutorial. Owners are guided by the home screen checklist.
- **Performance:** measured locally only.
- **Measures:** pilot measures undercount when a page closes offline.
- **Language and currency formats:** English only. Number separators are English style.

## 12. Features intentionally excluded from pilot

- **Payment gateways** (card or online payments). Payments are recorded as cash, transfer or POS. The switch is locked off in the API and the database.
- **AI agents.** Nothing acts on anyone's behalf. Photo reads and voice only fill drafts that a person checks.
- **Advanced accounting** (financial statements, tax returns). The switch is locked off. Terms section 13 says Bizora is not accounting or tax advice.
- **Plans, billing and limits.** Limits are off for every business.
- **Languages other than English**, including voice in Pidgin, Hausa, Yoruba and Igbo.
- **Tax calculations.** Tax fields are stored only.
- **Purchase orders and stock reservations.**

## 13. Manual pilot test checklist

People must do these on staging, then on each pilot business's phones. Automated tests behind each area are in `docs/PILOT_READINESS_CHECKLIST.md`.

1. **Sign up** on a phone and accept the Terms (version 2026-11-24). An existing owner sees the acceptance screen once.
2. **Email:** confirm email, reset password, the "password changed" email, invite a staff member, send a receipt, open a support view. Each arrives in a real inbox.
3. **Set up:** add the shop address, 5 products (one by camera scan, on Chrome for Android), a customer, and a staff member with a PIN on a shop phone.
4. **Sell:**
   - a cash sale;
   - a transfer sale (confirm it later);
   - a credit sale on standard terms;
   - a sale of a typed item;
   - a voice sale, checking every number;
   - two sales in one recording.
5. **Offline:**
   - in airplane mode, sell three times, add a product and count one line;
   - reload and close the tab;
   - go back online: everything sends once and nothing is lost;
   - a refused sale is named on screen.
6. **Stock:**
   - stock in with a batch and expiry;
   - sell from it;
   - take expired stock off;
   - transfer to a second shop and receive it;
   - run a count session and approve it.
7. **Serials:** stock in two phones with IMEIs, sell one, try to sell it again (refused), return it, and find it by IMEI.
8. **Reorder:** set a reorder point and fill-up level, then check To buy.
9. **Returns:** a return within the time limit; one after it (refused for staff, allowed for the owner).
10. **Money:** a POS cash-out, an expense, a cash count. Check the day's profit and the books.
11. **Reports:** the sales report for this week, month and year; download its CSV.
12. **Product file:** download products, change a price in a spreadsheet, and bring the file back in.
13. **Support:** open a support view from the Admin portal. The owner sees it in Settings › Bizora support and gets an email.
14. **Records:** the owner downloads all records from Settings.
15. **Phones:** repeat 3 to 6 on three real Android phones, including one with 2 GB of memory or less. Record the results in `PILOT_MOBILE_TEST_MATRIX.md`.

## 14. Go/no-go recommendation

**NO-GO today; GO for a controlled pilot once section 15 is cleared.**

- **The code is ready for a small, supervised pilot.**
  - Every money path is tested and balances.
  - Offline work is never silently lost.
  - Voice and every advanced inventory feature are off or need review.
- **The go decision needs:**
  - #59 merged and deployed;
  - the staging evidence (B3–B9) written down where each gate says;
  - a named support person (B10).
- **When everything is cleared, start with:**
  - 3–5 businesses, including one service business;
  - voice switched on only where the owner wants to try it.
- **Change this report's verdict to READY only after every blocker is cleared and logged.** Then tag `v0.9.0-pilot` (runbook step 10). Never call it production or generally available.

**Do not say,** in the app, on the website, in emails or to traders:
- that Bizora is production-ready, generally available or launched;
- that it holds any certification it does not have (ISO 27001, SOC 2, NDPC registration, or anything else);
- that voice understands Pidgin, Hausa, Yoruba or Igbo;
- that backups have been restored, or what the recovery time is, before the drill;
- that card or online payments are accepted.

## 15. Exact unresolved blockers

| # | Blocker | Who can clear it | How it is checked | Gate |
| --- | --- | --- | --- | --- |
| B1 | Service businesses that changed type cannot save sales until #59 is merged and deployed | Owner: merge #59 | `books-after-type-change.test.ts` in CI; a sale in a business switched to a service type on staging | G1 |
| B2 | Open PRs merged in order, `main` green with all of them together | Owner: merge (order below) | CI on `main` | G1–G3 |
| B3 | Staging passes `pilot-readiness-check.ts --url … --write` | Team with Google Cloud access | Runbook step 3 | G6 |
| B4 | S-3: sign-in limits see the person's real address | Team | Runbook step 4 | G7 |
| B5 | Backups confirmed in Google Cloud | Team | Runbook step 5 | G9 |
| B6 | All six emails arrive in a real inbox from staging | Team | Runbook step 6 | G8 |
| B7 | Restore drill run and logged | Team | Runbook step 7, `restore.md` drill log | G10 |
| B8 | Three real Android phones pass the matrix, one with 2 GB of memory or less | Team | `PILOT_MOBILE_TEST_MATRIX.md` | G12 |
| B9 | Performance on staging within targets | Team | Runbook step 8 | G17 |
| B10 | A support person, their hours and a support WhatsApp number named | Owner | Runbook step 15; `NEXT_PUBLIC_SUPPORT_WHATSAPP` set | G20 |

**Merge order for the open PRs:**
1. #58, #59, #60 (books and receipts);
2. #61, #62, #63;
3. #64, #65, #66, #67;
4. #68, #69, #70, #71, #72;
5. this PR.

Some PRs change the same lines of `apps/web/messages/en.json` and the Stock page. GitHub may ask for those to be updated after an earlier merge.

**Before general availability (not blocking the pilot):**
- PostgreSQL row-level security (issue #43);
- counsel's review of the Terms and privacy notice;
- container image scanning;
- upgrading vitest and removing the picomatch audit ignore;
- steadying the flaky tests;
- production set-up.
