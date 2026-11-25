# ADR-071: Bizora suspends and reinstates a business

## Status

Accepted on 25 Nov 2026. The pilot part of the business lifecycle design proposal of the same date. The Terms of use (section 9) already say Bizora may suspend an account; until now nothing could.

## Decision

### One field, one owner of it

- `organizations.bizora_hold` is `none` or `suspended`, with `hold_reason_code` (a category) and `hold_since` (migration 0054). Only Bizora staff change it. A later owner "close" and deletion will be separate fields, so lifting a suspension can never reopen a business its owner closed, and the reverse.
- Categories: fraud, security, abuse, terms, ownership, regulatory, payment_dispute, other. A database check ties the category and date to the state.
- **The note, case reference, review date and staff member live only in `business_lifecycle_events`**, which is append-only (the same trigger as sale comments). The organization row is sent to the owner's app whole, so nothing internal is kept on it.

### Who

| Action | Who | Extra checks |
| --- | --- | --- |
| See state and history | every portal role (`businesses.read`) | none |
| Suspend | super_admin, operations (`business.suspend`) | category and reason (5–500 characters); portal sign-in under 10 minutes old; optional case reference; review date (default 90 days) |
| Reinstate | super_admin, operations (`business.reinstate`) | reason; sign-in under 10 minutes old; for fraud or security, not the person who suspended |

- Suspending a suspended business, or reinstating one that is not, is refused (`ALREADY_SUSPENDED`, `NOT_SUSPENDED`). Each change locks the organization row.
- **Logged three ways:** the lifecycle events; the staff log (`admin_audit`, with the note); and the business's own activity log as `BIZORA_SUPPORT`, with the category only.
- The owner's "Bizora support" list shows the suspension and its category, not the note.
- The owner gets a notification for each change.

### What a suspended business can do

Enforced in the tenant guard, which already loads the membership on every request, so **old sessions, shop phones, the API and offline sync are all covered**. The rule is an allow-list:

- **Anyone** may load `GET /api/v1/auth/me`, so the app can say what happened.
- **The owner** may make any read (`GET`), including the records download.
- **Everything else is refused** with `BUSINESS_SUSPENDED` (403), with a plain message for the owner and another for staff.
- Other businesses, including others of the same person, are not affected.

### Offline work

- A phone's sync is refused like any other change, so its queued work **stays on the phone, in order**. The phone treats a refusal of the whole request as "try later" and backs off. Nothing is posted and nothing is dropped.
- After reinstatement, the next sync sends it, and idempotency keys make sure each item is recorded once.
- Signing out of Shop mode is already refused while work is waiting, so the queue cannot be wiped by accident.
- This is simpler than storing it on the server for review, and holds for every kind of offline work, not only sales.

### Sessions are not ended

The design proposal said staff would be signed out. In building it, keeping their sessions turned out safer:

- the guard already refuses everything they could do;
- a signed-in phone can show *why* ("This business is paused… Ask the owner") instead of a sign-in screen;
- its queued work keeps waiting rather than being stranded behind a sign-in.

### Screens

- **Admin portal**, business page → **Suspension**: state, category, since when, by whom, review date; **Suspend business** (category, case reference, reason) or **Reinstate** (reason); and the history with notes.
- **Business app:** the owner sees a red notice above every screen with the category, that nothing new can be recorded, that records can still be read and downloaded, and to contact support. Staff see only "This business is paused" in place of the screens.
- The notice loads only for a suspended business, so it adds nothing to anyone else's screens or the quick sale budget.

## Consequences

- The Terms' promise of suspension now has a mechanism, with reasons, two-person lifting for fraud and security, and full logs.
- Not in this change, from the same proposal: owner close and reopen, deletion with retention, several businesses per owner, account-level restrictions, re-registration checks. They come before general availability.
- The owner's screens still show buttons that will be refused; the server's message explains. Hiding them is a later polish.
- Tests:
  - `apps/api/src/business-suspension.test.ts`: who may act; reasons; fresh sign-in; owner reads and downloads only; staff and sync refused; nothing recorded; other business unaffected; note never reaches the business; append-only log and database checks; second person for fraud; queued sale recorded once after reinstatement.
  - `apps/admin/e2e/suspension.e2e.ts`: suspend and reinstate from the portal.
