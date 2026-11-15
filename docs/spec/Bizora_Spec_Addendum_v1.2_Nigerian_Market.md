# Bizora Spec Addendum v1.2 — Nigerian Market Adoption

**Status:** Approved · **Date:** 2026-11-15 (v1.1), updated 2026-11-15 (v1.2) · **Owner:** Peter Orazulike

**v1.2 changes:** added §15 Languages, §16 AI capture (voice, photos, instructions), §17 Payment & POS connections and reconciliation, §18 Accounting core; roadmap updated. **Out of scope until further notice:** bank-account feeds/open-banking aggregators (e.g. Mono), tax computation/returns, and NRS e-invoicing (MBS) integration.
**Applies to:** Bizora Master Build Specification v1.0
**Precedence:** Where this addendum conflicts with v1.0 on roadmap, UX language, onboarding, identity for staff, offline behaviour or messaging, **this addendum wins**. Everything else in v1.0 (tenant model, money rules, security, module boundaries, AI permissions) is unchanged.

---

## 1. Product principle

> Do not sell AI, CRM or ERP. Sell **more money, tighter control, less loss, faster collection and peace of mind.**

**Brand promise (use on the public site and in onboarding):**
*Know your money. Control your stock. Follow your customers. Run your business from anywhere.*
Tagline: *Bizora — Run your business intelligently.*

**Primary user:** the owner ("Oga/Madam") of a trading business or SME in markets such as Onitsha, Lagos, Alaba and Kano — often multi-location, often travelling, with shop staff who may not use email.

## 2. What stays the same (do not change)

- Organization = tenant; Business and Branch beneath it; server-derived tenant context; tenant isolation tests as a blocking gate.
- Money in `bigint` minor units with ISO 4217 codes; no floating point; decimal FX rates.
- RBAC, audit events, sessions with refresh rotation, Google + email/password sign-in for owners/admins.
- Modular monolith (NestJS), Next.js PWA, PostgreSQL, Google Cloud.

## 3. Revised roadmap (replaces v1.0 sprint order from Sprint 3B onward)

| Sprint | Scope |
|---|---|
| **3B** | Customers & follow-up (phone-first, WhatsApp contact, notes, call-back reminders); trader navigation and language; owner dashboard shell; local onboarding; market/shop address fields; i18n-ready strings; hydration-safe forms; public homepage, privacy policy, terms. **No leads/opportunities/pipeline.** |
| **3C.5a** | Roles; staff accounts with PIN on enrolled shop devices; plan entitlements; CSV import limits. |
| **3C.5b** | Offline-first ADR + sync foundation; **accounting core ADR + ledger foundation (§18)**. |
| **3D** *(any time)* | Translations: Pidgin, Hausa, Igbo, Yoruba; language switcher; translated emails/messages (§15). |
| **4** | Products & stock: product list, units, stock ledger per branch, stock in/out/adjust/transfer, low-stock alerts; posts to accounting ledger. |
| **5a** | Quick sales: record a sale in seconds; payment methods cash / transfer / POS / credit / split; staff attribution; discounts and credit by role; WhatsApp receipt link; works offline, and the core screens open with no network; posts to accounting ledger. **Imports:** products with opening stock, and past sales, from CSV files through a shared "check and edit before saving" screen (ADR-015). |
| **5b** | AI gateway + capture on Google Vertex AI (in the organization's Google Cloud project): photos of handwritten books, scanned records and voice notes → draft rows in the same review screen as imports, for products, stock-in and sales (§16). Nothing is saved until a person confirms. |
| **6** | Debtors & payments: receivables, partial payments, due dates, WhatsApp reminder links, simple invoices; **reconciliation inbox** and **statement upload (CSV/PDF)** (§17). |
| **7** | Money in / money out & owner dashboard: expenses, cash position per branch, daily profit, staff activity, discounts/voids report; chart of accounts settings. |
| **7.5** | Ask Zora: photo/scan → draft expenses; instructions ("remind everyone owing above ₦50k"); questions about the business (§16). |
| **8** | Connections: Paystack/Flutterwave payment links and dedicated customer account numbers; Moniepoint POS push-payment; all feeding the reconciliation inbox (§17). |
| **8.5** | Financial reports from the ledger: profit & loss, balance sheet, cash flow, debtors ageing, stock valuation (§18). |
| Later | Quotes, purchase orders, suppliers, WhatsApp Business API automation, advanced analytics, SMS OTP login. **Deferred indefinitely:** bank-account feeds (open banking aggregators), tax computation/returns, NRS e-invoicing. |

## 4. Language and navigation

Use trader language. Avoid ERP/CRM jargon in the UI ("lead", "opportunity", "pipeline", "SKU", "AR/AP", "ledger" are internal terms only).

| Internal concept | UI label |
|---|---|
| Sales orders / POS | **Sales** |
| Inventory | **Stock** |
| Customers / contacts | **Customers** |
| Accounts receivable | **Debtors** ("Who is owing me") |
| Cash book / expenses | **Money** (Money in · Money out) |
| Users / members | **Staff** |
| Analytics | **Reports** |

**Primary navigation (mobile bottom bar shows the first 4–5):** Home · Sales · Stock · Customers · Debtors · Money · Staff · Reports · Settings.
Hide Inbox, Purchasing and AI until those modules exist.

**Localization:** all UI strings in translation files from Sprint 3B (English first). The architecture must allow adding **Nigerian Pidgin, Hausa, Igbo and Yoruba** without code changes. Numbers, dates and currency formatted via `Intl` with locale `en-NG` by default.

## 5. Owner-control model

- **Home = owner's daily view:** today's sales, money in vs money out, cash at hand per branch, top debtors, low stock, staff activity, items needing approval.
- Every sale, discount, void, refund and stock movement records **who** (staff), **where** (branch/device) and **when**; visible to the owner.
- **Approvals:** discounts above a staff limit, voids, refunds and stock adjustments can require owner/manager approval (configurable).
- **Roles (extend existing RBAC):** Owner, Manager, Sales Staff (shop attendant), Storekeeper, Accountant/Advisor. Sales Staff see only their branch and cannot see cost price or profit unless granted.

## 6. Staff identity: PIN on enrolled shop devices

Shop staff often have no email. Staff can therefore be created **by the owner/manager** without email:

- Staff record: display name, role, branch, optional phone (E.164), **4–6 digit PIN** (argon2id hashed).
- **Device enrollment:** an owner/manager signs in on a phone/tablet and turns on **Shop mode** for a branch. This creates a revocable device credential (long random token, stored hashed server-side, httpOnly cookie on the device).
- **Staff PIN login works only on enrolled devices of that organization/branch.** A PIN alone is never a credential on the open internet.
- Quick staff switching on a shared device; auto-lock after inactivity (configurable, default 5 minutes).
- Brute-force protection: 5 failed PIN attempts → that staff member is locked on that device for 15 minutes; 20 failures on a device → device requires owner re-approval. All attempts audited.
- Staff sessions are short-lived, branch-scoped, and use the existing session/refresh model with `actorType = staff_pin` in audit.
- Owner can see enrolled devices, revoke a device, reset a PIN, deactivate staff.
- Staff who do have email/Google may still be invited the normal way.
- SMS OTP login is **deferred** (cost); design must not block adding it later.

## 7. Offline-tolerant operation

**Must work during temporary connectivity loss (then sync):** record a sale (cash/transfer/POS/credit), look up and create customers, look up products and stock levels (last synced), record stock in / stock count.
**Online-only:** online payment links, user/role/billing administration, reports over large date ranges, settings.

**Architecture rules (ADR required in Sprint 3C.5, before Sprint 4/5 build on it):**
1. **Client-generated IDs** (UUIDv7) for offline-creatable records.
2. **Idempotent writes:** every offline-capable mutation carries an `Idempotency-Key`; the server stores keys per tenant and returns the original result on retry.
3. **Stock is an append-only ledger** of movements (`+received`, `−sold`, `±adjusted`, transfers); on-hand quantity is derived. Offline movements from multiple devices merge without overwrite. Negative stock after sync is allowed but **flagged for owner review**, never silently corrected.
4. **Document numbers:** devices issue provisional numbers (e.g. `B12-DEV3-000045`); the server assigns the official sequential number on sync; receipts show both when they differ.
5. **Local store:** IndexedDB with an outbox queue; background sync with exponential backoff; visible status ("3 sales waiting to sync"). Server is authoritative; conflicts on editable records use last-writer-wins with audit, except money and stock, which are append-only.
6. **Shared devices:** locking the app or switching staff hides data; signing out of Shop mode clears the local store. Cache only what the branch needs.
7. Tenant isolation applies to sync endpoints exactly as to normal endpoints (tests required).

## 8. Mobile-first and low-data

- Target device: affordable Android (≈2–3 GB RAM), Chrome, 3G/unstable 4G.
- Performance budgets (CI-enforced from Sprint 4): initial JS for core screens ≤ 170 KB gzipped; Largest Contentful Paint ≤ 2.5 s on Lighthouse "Slow 4G, mid-tier mobile"; no layout shift on forms.
- No decorative images on core screens; compress any images; paginate lists (25 per page) with search; avoid polling.
- **Hydration-safe forms:** submit buttons disabled until the client handler is attached (or forms degrade gracefully), everywhere.
- Large tap targets (≥ 44 px), one-handed use, numeric keypads for amounts and phone numbers.

## 9. WhatsApp-first

- **Stage 1 (Sprint 3B onward, no cost):** "Share on WhatsApp" / "Chat on WhatsApp" using `https://wa.me/<E.164 without +>?text=<prefilled>` with a link to a **light public document page** (receipt, invoice, statement of account).
  - Public document links use unguessable signed tokens, expire/revocable, show only that document, `noindex`, no tenant internals.
- **Stage 2 (later, paid plan):** WhatsApp Business Cloud API for automated debtor reminders and receipts (requires Meta business verification, approved templates, per-conversation cost). Build behind a `MessagingPort` so the provider is swappable.

## 10. Payments and currency

- Record payments by method: **cash, bank transfer, POS (card terminal), online link, credit (pay later)**, and **split** across methods. Partial payments on credit sales.
- Do not force a single payment method or provider.
- **NGN default.** Support USD, GBP, EUR, CNY and any ISO 4217 currency for import/export businesses.
- **Trader-entered exchange rates:** a transaction in a foreign currency stores the rate the trader actually used (decimal string), plus optional reference rate. Never silently substitute an official rate.

## 11. Local onboarding

After sign-up, ask (one question per screen on mobile):
1. Business type (e.g. provisions/FMCG, electronics, fashion/textiles, building materials, auto parts, pharmacy/cosmetics, food/restaurant, services, other).
2. Where you trade: market/plaza/area + city/state (uses address fields below).
3. Main currency (NGN default) and whether you buy/sell in other currencies.
4. How many staff (0, 1–3, 4–10, 10+) and how many shops/branches.
5. What you sell (pick categories / add first few products — optional, can skip).
Then **auto-configure**: menu modules shown, default units/categories, staff features on/off, multi-currency on/off, a short "first steps" checklist.

**Addresses:** add optional `market_or_plaza`, `line_or_block`, `shop_number` fields so "Shop B12, Line 4, Main Market, Onitsha, Anambra" fits naturally.

## 12. Plans and entitlements

- Build an **entitlements service** (Sprint 3C.5): plan → limits/features (staff count, branches, devices, WhatsApp automation, advanced reports, AI, integrations). Enforced server-side; UI shows upgrade prompts, never hard errors.
- Entry plan: one shop, owner + limited staff. Paid upgrades: more staff, branches, advanced analytics, AI, messaging, integrations.
- Pricing must feel smaller than one recovered debt or one prevented stock loss. Billing integration is a later sprint; entitlements come first.

## 13. Public site (required for launch and Google brand verification)

- `/` public homepage (logged-out) using the brand promise and trader pain points: daily profit, missing stock and staff leakage, debtors, control from anywhere, WhatsApp selling.
- `/privacy` and `/terms` pages (plain language; reference Nigeria Data Protection Act 2023; reviewed by a lawyer before production).
- Light, fast, no tracking scripts by default.

## 14. Definition of done additions (all sprints from 3B)

- UI copy uses Section 4 language; strings in translation files.
- Mobile layout verified at 360 px width and on throttled network.
- Forms hydration-safe.
- New tenant-owned tables: composite tenant FKs, isolation tests (read/update/delete → 404 cross-tenant).
- Offline-capable features (from Sprint 5): idempotency and sync tests.

---

## 15. Languages (v1.2)

- Supported locales (target): `en-NG` (default), `pcm` (Nigerian Pidgin), `ha` (Hausa), `ig` (Igbo), `yo` (Yoruba). Fallback to English for any missing string.
- **Everything user-facing is translatable:** web UI, API error messages (by error code → message key, never raw English from the server), emails, WhatsApp message templates, public document pages (receipts/invoices).
- **Language preference** per user (and per staff member in Shop mode), defaulting from the browser; switcher in the user menu and on the PIN pad. Customer-facing messages (receipts, reminders) can use a per-customer preferred language.
- **Translation workflow:** AI-drafted first pass → **native-speaker review required** before a locale is enabled (feature flag per locale). Yoruba and Igbo must keep correct tone marks/diacritics; Pidgin follows a documented house spelling guide in `docs/i18n/pcm-style.md`.
- Priority order: Pidgin, Hausa, then Igbo and Yoruba.
- Tests: missing-key check per locale; pseudo-locale run to catch truncation on 360 px screens.

## 16. AI capture: voice, photos and instructions (v1.2)

**Principle (from v1.0 AI permissions): AI drafts, a human confirms.** AI never records or changes money, stock, customers' debts or messages to customers without explicit user confirmation. Audit `actorType` distinguishes `ai_draft`, `ai_suggestion_accepted`, and (future, opt-in only) `ai_executed`.

**Capabilities and timing**
- Sprint 5b: **voice → draft sale** ("I sell 3 carton Indomie give Chika, she pay 20k transfer, balance na credit"); **photo/scan of supplier invoice, delivery note, handwritten note or WhatsApp screenshot → draft stock-in**.
- Sprint 7.5 (Ask Zora): photo → draft expense; **instructions** → proposed action list for approval (e.g. bulk debtor reminders); questions about the business answered from the tenant's own data only.

**Architecture**
- A single **AI gateway** module (provider-agnostic adapters for speech-to-text, vision/OCR and language models); providers selected by config; no provider SDKs outside the gateway.
- **Draft review screen** for every capture: extracted fields, confidence highlighting, original audio/image viewable, edit before confirm; unmatched products/customers offered as "create new" or "pick existing".
- **Nigerian parsing rules:** amounts like "20k", "2.5m", "fifty thousand", "₦", "N"; Pidgin and code-switching; quantities/units ("carton", "bag", "dozen", "paint").
- **Offline:** audio/photos captured offline are queued and processed when online; the draft appears for review afterwards.
- **Low data:** images resized/compressed on device (target ≤ 200 KB); audio as short compressed clips (Opus), max 60 s per clip.
- **Cost control:** AI features are plan entitlements (§12) with per-tenant monthly quotas; usage metered and shown to the owner.
- **Privacy:** only the minimum data needed is sent; providers must offer a data-processing agreement with **no training on customer data**; data residency documented; disclosed in the privacy policy (NDPA 2023). Captured media retained only as long as configured (default 90 days), then deleted.
- **Evaluation:** before choosing providers, run a benchmark with real recordings/photos from target markets (English, Pidgin, Hausa, Igbo, Yoruba; noisy market audio; handwritten notes) and record results in an ADR. Re-run the benchmark when changing providers.
- **Safety:** prompt-injection-resistant handling of document text (document content is data, never instructions); tenant isolation on all AI inputs/outputs; no cross-tenant retrieval.

## 17. Payment & POS connections and reconciliation (v1.2)

**Scope:** connections where payments arrive already identifiable. **Bank-account feeds via open-banking aggregators are out of scope** until further notice.

**Rule: Bizora never holds or moves customers' money.** Funds always settle into the business's **own** provider account (Paystack, Flutterwave, Monnify/Moniepoint) or bank account. Bizora reads, matches and records only. This keeps Bizora outside payment-licensing requirements; any change to this rule needs legal review and an ADR.

**Connections (Sprint 8)**
- **Payment providers (Paystack, Flutterwave):** the business connects its own account (API keys stored as encrypted per-tenant secrets, never in logs). Bizora creates **payment links** for sales/invoices and **dedicated account numbers per customer** (where the provider supports it and the business qualifies). Provider webhooks (signature-verified, replay-protected, idempotent by provider event ID) create payment records matched exactly to the sale/invoice/customer.
- **POS (Moniepoint first):** Bizora pushes the sale amount to the terminal with a merchant reference; terminal result arrives by signed webhook and marks the sale paid by POS. Other POS providers via the same `PosPort` interface later.
- **Manual and statement import (Sprint 6):** cash/transfer/POS payments recorded by staff; **CSV/PDF bank statement upload** to match transfers the owner received directly (PDF parsing via the AI gateway when available).

**Reconciliation inbox (Sprint 6, extended in Sprint 8)**
1. **Exact matches** (provider/POS reference, dedicated account → customer) post automatically.
2. **Suggested matches** by amount, date window and payer name similarity → owner confirms with one tap.
3. **Unmatched** items → classify as money in (category), customer payment on account, or **transfer between own accounts** (never counted as income).
4. **Rules** the owner can save (e.g. "transfers from DANGOTE DISTRIB → supplier refund"); suggested automatically after repeated manual matches.
5. Duplicates prevented across sources (same payment seen via webhook and statement is matched once).
- Every match/unmatch is audited and reversible by an owner/accountant.

## 18. Accounting core (v1.2)

Traders never see accounting jargon (§4), but every financial event is recorded in a **double-entry ledger** so that profit, cash and balance reports are trustworthy.

- **Design first:** ADR and ledger foundation in Sprint 3C.5b, **before** stock (Sprint 4) and sales (Sprint 5) are built, so they post entries from day one.
- **Chart of accounts:** sensible default template per business type (cash per branch, bank/provider accounts, POS clearing, debtors, stock, sales, cost of goods sold, expenses by category, owner's equity/drawings, suppliers payable, FX gains/losses). Editable by Owner/Accountant later (Sprint 7).
- **Journal entries:** immutable and balanced (debits = credits per entry, enforced in the database); corrections only by reversing entries; every entry links to its source document (sale, payment, expense, stock movement, reconciliation) and is tenant-, business- and branch-scoped with composite tenant FKs.
- **Automatic posting:** domain events (sale completed, payment received, stock received/adjusted, expense recorded, reconciliation confirmed) post entries through one `LedgerPostingService`; modules never write ledger rows directly.
- **Money:** `bigint` minor units per currency; foreign-currency entries store the original amount, currency and the **trader-entered rate**, plus the NGN (base currency) amount.
- **Stock costing:** weighted-average cost per product per branch (ADR to confirm), used for cost of goods sold and stock valuation.
- **Periods:** monthly periods; owner/accountant can lock a period (no postings into locked periods; corrections go into the open period).
- **Offline:** ledger postings happen on the server when synced items are accepted; devices never write ledger entries.
- **Reports (Sprint 8.5):** profit & loss, balance sheet, cash flow, cash position per branch/account, debtors ageing, stock valuation, sales by staff/product. Exports to CSV/PDF for the owner's accountant.
- **Not in scope:** tax computation, tax returns and NRS e-invoicing. Tax fields (e.g. VAT rate on a line) may be stored as configurable data only if needed for invoices, with no tax logic.

## 19. Definition of done additions (v1.2)

- Any feature that moves money or stock posts balanced ledger entries via `LedgerPostingService` (from Sprint 4), with tests that the trial balance stays balanced.
- Webhook endpoints: signature verification, replay protection, idempotency, tenant resolution from the connection (never from payload alone), tests for forged/replayed events.
- AI features: human confirmation step, audit actor type, quota enforcement, and tests that document text cannot trigger actions.
- New user-facing strings in all enabled locales or behind fallback.
