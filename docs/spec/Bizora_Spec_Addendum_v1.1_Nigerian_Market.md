# Bizora Spec Addendum v1.1 — Nigerian market

This addendum adapts Bizora for owners who trade in Nigerian markets, plazas, and shops. It is read together with the Master Build Specification v1.0.

Where this addendum and v1.0 disagree on roadmap, UX language, onboarding, staff identity, offline behaviour, or messaging, **this addendum wins**. Everything else in v1.0 still stands.

Sprint 3B delivers the work in sections 3, 4, 5, 6, 8, 9, 11, and 13. Section 14 is the definition of done.

## 1. Who this is for

The person holding the phone is the owner. They may also call themselves a trader, a shop owner, or a market seller. Copy speaks to that person in plain language. It does not speak like an ERP or a CRM.

Nigeria is the default market: locale `en-NG`, currency NGN, timezone Africa/Lagos, and addresses that start with shop, line, and market. The product still supports other countries already in the reference data.

## 2. What this addendum preserves

Do not remove, rewrite, or weaken any of the following. New work is additive: new migrations only, no edits that drop or reinterpret existing rows.

- Organization is the security and billing tenant. Businesses belong to a tenant. Branches belong to a business. Every tenant-owned row stores `tenant_id`. Composite foreign keys stay tenant-safe.
- Request scope comes from the verified session. Client tenant, organization, business, and branch headers are ignored. `POST /api/v1/auth/select-context` is the only way to change active scope.
- Sign-in stays email and password, plus Google when it is configured. Microsoft stays removed. Sessions, refresh rotation, password reset, and email verification stay as shipped.
- Roles and the existing permission codes stay. New permissions are added. They are not a replacement for `tenant.read`, `users.invite`, settings permissions, or branch permissions.
- Addresses, countries, and subdivisions stay. New address columns are optional. Existing addresses remain valid.
- Country, base currency, timezone, industry, names, phones, and branding already stored for an organization or business stay. Completing the new onboarding questions must not wipe them. A migration may backfill new columns from old ones. It must not delete old columns or old values.
- Money stays integer minor units. Audit events stay append-only. The teal design tokens stay the visual system.
- Offline sync, staff PIN login, entitlements, leads, opportunities, pipeline, AI, and the WhatsApp Business API are not part of this addendum's build. A `wa.me` link is a normal link, not the Business API.

## 3. Customers

Customers are tenant-owned and business-scoped.

A customer has a name, a phone in E.164, an optional email, an optional address (the existing address table), tags, a short notes summary, `created_by`, and a branch. Phone is required unless the customer is marked walk-in, in which case the phone is empty.

The phone is the primary identifier inside a business. Saving a phone that already belongs to another customer in that business returns a duplicate warning and does not create a second customer. Search is by name or phone, paginated at 25 rows.

The customer page shows details, a notes timeline, and follow-ups. It offers Call (`tel:`) and Chat on WhatsApp (`wa.me` with a greeting that comes from the translation catalog). Purchases and Owes are visible placeholders only.

CSV import accepts name, phone, email, and notes. The importer shows a preview and a validation error per bad row. Phones are normalised to E.164 with the business country. Importing the same phone again updates that customer. Import uses the caller's tenant and business only.

## 4. Trader navigation and language

The signed-in navigation is:

Home · Sales · Stock · Customers · Debtors · Money · Staff · Reports · Settings

The mobile bottom bar is Home, Sales, Customers, Debtors, and More. More holds the rest.

Inbox, Purchasing, and AI are hidden.

Customers is live. Every other new module keeps a Coming soon page written as what it will do for the owner, not as a module name from an ERP roadmap.

Onboarding answers may hide Stock (services) and Staff (the owner works alone). Home, Customers, and Settings stay visible. The owner can change that later in Settings.

Replace organization, workspace, tenant, industry-pack, and similar jargon in the interface with words an owner would use: business, shop, what you sell, staff.

## 5. Owner home

Home is a set of cards:

- Today's sales
- Money in vs out
- Cash at hand
- Top debtors
- Low stock
- Staff activity
- Needs approval
- Follow-ups due today

Only follow-ups due today and the customer count are live. The other cards explain themselves with an empty state such as "Start recording sales to see this".

A setup checklist is driven by the onboarding answers. Invite staff only when the owner said they have staff. Record what you sell only when that answer is still empty. Add the first customer until one exists.

## 6. Language

The web app uses a message catalog. The default locale is `en-NG`. English copy lives in `messages/en.json`. The catalog list includes `pcm` (Nigerian Pidgin), `ha`, `ig`, and `yo`. Adding or editing those catalogs must not require a component change. Missing keys fall back to English.

Numbers, dates, and currency use `Intl` with the active locale. A check fails the build when a component hard-codes interface copy.

## 7. Out of scope for this sprint

Sales documents, stock movements, debtors and payments, money in and out, offline sync, staff PIN login, entitlements, leads, opportunities, pipeline, AI, and the WhatsApp Business API.

## 8. Hydration-safe forms

`packages/ui` provides one form and submit primitive. The submit control stays disabled until the form has hydrated. While a submit is in flight the control shows a pending state and ignores a second submit. Login, register, onboarding, settings, invite, password reset, and customer forms all use it.

## 9. Follow-ups

A follow-up belongs to a customer and has a due time, a reason, an optional staff assignee, and a status of open, done, or snoozed.

The owner creates one from the customer page, browses Due today, Overdue, and Upcoming, and can mark one done or snooze it. Due today is the live card on Home.

## 10. Permissions, scope, and audit

New permission codes:

- `customers.read`
- `customers.manage`
- `followups.manage`

The owner, administrator, manager, and sales staff can manage customers and follow-ups. Sales staff are limited to their own branch: another branch is a not-found, not a list of someone else's customers. Read-only roles may look but not change. Roles without these permissions are denied.

Create, update, delete, import, note, and follow-up actions write audit events. Tenant B receives 404 for Tenant A's customers, notes, and follow-ups. A CSV import cannot read or update another tenant's rows.

## 11. Onboarding and addresses

After sign-up, onboarding asks one question per screen on a phone:

1. Business type
2. Where you trade: market or plaza, city, and state
3. Main currency, and whether other currencies are taken
4. How many staff
5. How many shops or branches
6. What you sell, which can be skipped

Answers are stored on the organization and the business. They set which nav modules show, whether other currencies are on, whether staff features are on, and which checklist items appear. Settings can change the answers later.

Addresses gain optional `market_or_plaza`, `line_or_block`, and `shop_number`. The address form shows those first when the country is Nigeria. A formatted Nigerian address reads like "Shop B12, Line 4, Main Market, Onitsha, Anambra".

## 12. Phone numbers

Local numbers are normalised with the business country. A Nigerian `0803…` number becomes `+234803…`. Invalid numbers are rejected. Walk-in customers are the only customers without a phone.

## 13. Public site

`/` for a logged-out visitor is a light, fast, teal page with the brand promise and the pains of running a shop. It does not load tracking. A logged-in visitor opening `/` goes to `/app`.

`/privacy` and `/terms` are plain language. They name the Nigeria Data Protection Act 2023 and are marked "Draft — to be reviewed by counsel".

Public pages, login, and register link to privacy and terms in the footer.

## 14. Definition of done

This sprint is done when all of the following are true:

- New SQL migrations only. Existing onboarding columns and values still load.
- The navigation, home, onboarding, address fields, customers, follow-ups, forms, and public pages match this addendum.
- Interface copy is in the English catalog. The hard-coded copy check passes.
- API tests prove tenant isolation, sales-staff branch scope, permission denials, Nigerian phone normalisation, and the duplicate-phone warning.
- Playwright walks onboarding into the dashboard, adds a customer, a note, and a follow-up that shows on Home, checks the WhatsApp link, imports three CSV rows, runs at a 360px viewport, and renders `/`, `/privacy`, and `/terms` while logged out.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm audit --prod`, `terraform validate`, and Playwright pass.
- One pull request. It is not merged. Merging deploys to staging.
