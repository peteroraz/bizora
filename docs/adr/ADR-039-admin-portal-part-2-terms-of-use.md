# ADR-039: Admin portal part 2: Terms of use, support view, limits per business

## Status

Accepted on 20 Nov 2026. Builds on ADR-037.

## Context

- **The old plan.** It said Bizora staff would see inside a business only after the owner tapped Allow, for each look.
- **The owner's decision (20 Nov).** No approval each time. Instead, every owner accepts usage terms that say Bizora staff may see their records. The terms are linked from sign-up, with a box to tick.
- **What part 1 left out.** Limits per business and usage counts were still missing.

## Decision

### Terms of use

- **Text.** A full Terms of use replaces the short draft at `/terms`, in 12 sections. Section 5, "When Bizora staff can see your business" (`/terms#bizora-access`), is the access clause.
  - Authorised staff may see the account and records without asking each time, when needed: support, faults, checking figures, security, fraud or disputes, or the law.
  - Access is read-only, at most an hour at a time, and needs a reason.
  - Customers' phones and emails are partly hidden.
  - Every look is logged and shown to the owner.
  - Staff never create, change or delete records.
- **Privacy notice.** It says the same in one paragraph.
- **Version.** `TERMS_VERSION` (`2026-11-20`) in contracts. Changing it asks every owner to accept again.
- **Sign-up.** A required "I agree to the Terms of use" box, linked to the terms, with a short note and a link to section 5. The API takes `acceptTerms: true` and records it in `terms_acceptances` (user, organization, version, method `sign_up`, IP, browser, time).
- **Owners without an acceptance** are sent to `/accept-terms` before any page under `/app`. This covers Google sign-up and future versions. `/api/v1/auth/me` returns `termsRequired`, and `POST /api/v1/auth/accept-terms` records method `in_app` and an audit event.
- **Who must accept.** Only owners, who agree for their business. Staff work under their owner's acceptance.

### Support view

- **Who.** Ability `records.read`, for super admins and support only.
- **Opening it.** A reason is required. It lasts 60 minutes (`SUPPORT_VIEW_MINUTES`), per staff member and business, in `admin_support_views`. It can be closed early.
- **What it shows.** Read-only pages for sales, stock, customers, who owes, cash and profit, and activity, at `GET /api/admin/v1/businesses/:id/records/:page`.
  - Reads go through the app's own services, as the owner would see them, with read permissions only. Nothing that writes is ever called.
  - Customers' phone numbers and emails are partly hidden (`+234***567`, `c***@mail.test`).
- **Logging.** Each page read writes `support.viewed` to the staff log and to the business's `audit_events` as `BIZORA_SUPPORT`, with the staff email and reason.

### The owner sees Bizora support

- **Where.** Settings → **Bizora support** lists every look and action by Bizora staff in that business, with email, time, reason and page.
- **Route.** `GET /api/v1/support-activity`, needing `audit.read`.

### Limits per business

- **Who.** Ability `limits.manage`, for super admins and operations.
- **What.** Shops, staff, shop phones, and photo or voice reads a shop a day.
- **How.** Values are stored in `organization_plans.limit_overrides` and win over the plan in `EntitlementService.plan()`. An empty value goes back to the plan.
- **AI cap.** Reads stay capped by the service-wide `AI_DAILY_CAPTURE_LIMIT`.
- **Logging.** Changes need a reason and go to both logs.

### Usage

- The business page shows sales in the last 30 days, products and customers: counts only, never amounts.

## Consequences

- **Legal review.** The terms are still marked as a draft for counsel. Governing law (Nigeria) and the liability cap (₦50,000 or what was paid in 12 months) need confirming.
- **Existing owners** see the acceptance screen once, the next time they open the app.
- **Feature switches per business are not built.** No feature is gated by plan yet, so a switch would change nothing.
- **Not built yet:** service-wide AI figures (failures, time taken, cost) and service health. They stay in the plan for later.
