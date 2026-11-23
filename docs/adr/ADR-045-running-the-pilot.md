# ADR-045: Running the pilot (switches, records export, measures, sample business, error wording)

## Status

Accepted on 23 Nov 2026, as part of the pre-pilot readiness sprint (items 14, 17, 18, 19, 21 and 29). Builds on ADR-018 (photo and voice capture), ADR-037 and ADR-039 (Admin portal and support view) and ADR-040 and ADR-041 (offline voice).

## Context

- **The brief.** A controlled pilot with Nigerian traders needs Bizora staff to:
  - switch parts of the product off for one business;
  - see whether the pilot is working, without reading anyone's records;
  - give owners their data;
  - demonstrate the product without a real business;
  - show people errors they can act on.
- **What existed.**
  - Plan features (`plans.limits.features`) that nothing checked.
  - Limits per business (ADR-039).
  - Browser error reports to Error Reporting (ADR-036).
  - A setup checklist on the home screen.
  - No export, no pilot measures, no sample business.
- **Error wording.** Framework messages reached people as written:
  - "ThrottlerException: Too Many Requests";
  - "Forbidden resource";
  - "Validation failed (uuid is expected)";
  - "Request validation failed.";
  - "An unexpected error occurred."

  The last two also reached the offline outbox's list of refused sales.

## Decision

### Switches for one business

- **Table.** Migration 0039 adds `business_features (tenant_id, feature, enabled, reason, changed_by_staff_id, updated_at)`. A business with no row gets the product default.
- **Switches and defaults.**
  - Each switch starts as the product works today, so nothing changes until someone flips one.
  - `offline_voice`: on.
  - `photo_reads`: on. The privacy page already says photos go to Google Cloud.
  - `support_view`: on.
  - `advanced_accounting` and `payment_gateways` are not built. They are **locked off**: the API refuses to switch them on (`FEATURE_LOCKED`), and so does a database check constraint.
- **Who switches.** Bizora staff with `limits.manage` (operations and super admins), in the Admin portal's **Switches for this business** panel.
  - Every change needs a reason.
  - Each change goes into the staff log and the owner's activity log.
- **Where switches are enforced.**
  - **Photo reads:** on the server, in `CaptureService`. The status shows them as off, and capture is refused with `FEATURE_OFF` and "Type the rows instead."
  - **Support view:** on the server. Opening a view is refused, and so is reading through a view that is already open.
  - **Offline voice:** in the app only. `/auth/me` returns `features`, and the quick sale screen and Settings hide voice.
    - Voice runs on the phone, so a phone that already downloaded the model keeps the files until they are removed in Settings.
    - Sales said by voice go through the normal sale path, so nothing is refused for having been spoken.
    - This limit is stated on the panel.
- **Plan features.** `plans.limits.features` stays as it was. Pilot switches are per business, not per plan, and are kept apart so that billing can come later.

### Business records export

- **Endpoint.** `GET /api/v1/exports/business` returns a ZIP of CSV files, one per kind of record, plus a `README.txt` that explains minor units, quantities in thousandths and IDs.
  - Requires `tenant.manage` (owner and administrators).
  - Limited to 5 downloads in 10 minutes.
  - Sent with `cache-control: no-store`.
  - Recorded as `business.exported` with file and record counts.
- **What is included.** An allowlist of 33 tables, filtered by `tenant_id` from the session.
- **What is left out.** Columns named `*_token` or `*_hash`, `ip`, `user_agent`, and pictures (bytea).
- **Formula safety.** A text cell starting with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading `'`. Numbers are not changed, so `-500` stays a number.
- **Exact values.** Every value is read as `::text`, so money and quantities are exact whole numbers, never JavaScript numbers.
- **ZIP format.** A ~60-line ZIP writer (`common/zip.ts`, deflate, using Node's `zlib.crc32`), so no new package is added. It was checked with Python's `zipfile`.
- **Size cap.** More than 500,000 rows in one file is refused (`EXPORT_TOO_BIG`) rather than exhausting memory. Pilot businesses are far below this.

### Pilot measures

- **What is kept.** `pilot_events (tenant_id, event, detail, occurred_at)`.
  - `event` matches `^[a-z][a-z0-9_.]{1,47}$`.
  - `detail` is a short code (`^[A-Za-z0-9_.:-]{1,48}$`), enforced by both the API and the database.
  - No people, no amounts, no words, no customer details.
- **Server events.**
  - Sync outcomes, recorded by `SyncController` after each push: `sync.applied` and `sync.duplicate` with the operation type, and `sync.rejected` with the refusal code.
  - They are recorded at the controller, so `SyncService` is unchanged (it is changed in another open pull request).
- **Phone events.** `POST /api/v1/telemetry/events` takes up to 25 events, signed in only, 60 a minute, from a fixed list: voice download started, finished, failed or cancelled; review shown; sale confirmed; review closed; read failed; typed instead.
  - `lib/pilot-events.ts` batches them in memory and sends them when online.
  - Events are lost if the page closes while offline. Measures must never slow a sale, so this is accepted and stated on the measures page ("they undercount").
- **Best effort.** A measure that cannot be saved is logged and dropped; it never fails the request it describes.
- **Admin portal, Pilot measures page** (`businesses.read`). For the last 7, 14, 30 or 90 days, per business:
  - when it was last active, and people active;
  - sales, offline sales, credit sales and cancelled sales;
  - debt payments and customers;
  - sale value per currency in minor units;
  - event counts.
  - Totals leave out sample businesses.
- **First steps.** Counted from the records themselves, not from events, so they are complete and need no phone to be online:
  - signed up;
  - finished setup;
  - first product;
  - first stock recorded;
  - first sale;
  - first credit sale (first debtor);
  - first debt payment;
  - first offline sale.

  The page shows how many businesses ever reached each step, and every business's dates. Totals count every business; the list shows the 500 newest.
- **Admin portal, business page: Last 7 days panel.**
  - Sync refusals by code, and voice problems.
  - Open sessions and shop phones signed in.
  - Last activity and last offline sync.
  - App errors stay in Cloud Logging and Error Reporting (ADR-036); the panel says where to look.

### What Google Cloud already measures

The rest of the brief's item 17 comes from Cloud Run and Error Reporting, which already collect it without any personal data being added:

| Measure | Where to look |
| --- | --- |
| Crashes in the app | Error Reporting, service `bizora-web-browser` (ADR-036) |
| API errors | Error Reporting, service `bizora-api`. Alert: more than 5 server errors in 5 minutes (`monitoring.tf`). |
| Slow requests | Logs Explorer: `resource.type="cloud_run_revision" resource.labels.service_name="bizora-api" httpRequest.latency>"2s"` |
| Failed sign-ins | Logs Explorer: `resource.labels.service_name="bizora-api" httpRequest.requestUrl:"/api/v1/auth/login" (httpRequest.status=401 OR httpRequest.status=429)` |
| Voice switched on by a phone | `voice.download_finished` in the pilot measures |

### Sample business

- **Marking.** `organizations.is_sample`.
  - The app shows a "Sample business" banner.
  - The Admin portal marks it.
  - Pilot totals leave it out.
- **Creating one.** `pnpm --filter @bizora/api sample create [--email …]` makes one **through the API itself**: 4 products with stock, 3 customers, 8 cash or transfer sales, a credit sale and a debt payment.
  - Because it uses the API, its books are real double-entry books.
  - The password is random and printed once.
  - The verification email is not sent (console adapter).
- **Removing them.** `sample remove --yes` deletes every sample business, then the people who belong to no other business.
  - It deletes table by table, in rounds, until foreign keys allow every row to go.
  - Journal entries, stock movements, returns and sale comments cannot be deleted by design. Migration 0039 adds one exception: a **delete** of a **sample** business's row, inside a transaction that set `bizora.remove_sample = on`.
  - Updates are still refused for everyone, and real businesses' rows are still refused with the setting on (tested).

### Error wording

- `ErrorEnvelopeFilter` replaces framework messages with plain words for each status:
  - 400: "Some details are missing or not right. Check them and try again."
  - 401: "Sign in again to continue."
  - 403: "You do not have permission to do this. Ask the business owner."
  - 404: "This could not be found. It may have been removed."
  - 409: "This was changed by someone else. Refresh and try again."
  - 413: "This is too big to send. Use a smaller photo or file."
  - 429: "Too many tries. Wait a minute, then try again."
  - 5xx: "Something went wrong on our side. Try again in a moment. If it keeps happening, tell Bizora support this code: `<first 8 characters of the correlation ID>`."
- Messages written for people (every `ApiError`, and `BadRequestException("Choose a shop first.")`) are kept.
- Offline refusals use the same validation wording.

### Setup checklist

The home screen's setup checklist already uses business words: add products, the shop address, the first customer, invite staff, record the first sale. Each item links to where to do it. It is unchanged.

## Consequences

- Operations can run the pilot business by business without a deploy, and every switch is visible to the owner.
- Owners can take their data with them, in a form a spreadsheet opens, at any time.
- Pilot success can be measured from counts, without opening any business's records.
- **Gaps:**
  - Voice downloads started from Settings are not yet counted, and a stopped download is not counted as cancelled. Those screens are changed in the offline and mobile pull request; the events follow once both are merged.
  - Measures from phones undercount when a page closes offline.
  - The measures page lists the 500 newest businesses; the totals count all.
  - Failed sign-ins are counted from request logs, not per business: a failed sign-in has no business.
  - PGlite does not show every difference from the real driver: raw queries with JavaScript `Date` values failed only on Postgres. The measures queries now pass times as text, and were run against a real Postgres database.
