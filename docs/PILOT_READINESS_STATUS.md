# Pilot readiness status

Every capability, labelled, as of **24 Nov 2026**. "main" means merged and on staging. "#nn" means an open PR, CI green, waiting to be merged. The verdict and blockers are in `docs/PILOT_READINESS_REPORT.md`; the gates and their tests are in `docs/PILOT_READINESS_CHECKLIST.md`.

**Labels:**

| Label | Meaning |
| --- | --- |
| **IMPLEMENTED** | Built and tested. Nothing more is needed for the pilot. |
| **IMPLEMENTED BUT NEEDS PILOT VALIDATION** | Built and tested, but only real use can prove it: real phones, real speech, a real inbox, staging. |
| **PARTIAL** | Some of it is built. What is missing is stated. |
| **NOT IMPLEMENTED** | Not built. Why, and how it is handled, is stated. |
| **NOT REQUIRED FOR PILOT** | Deliberately not built for the pilot. |

## A. The business app

| Capability | Label | Where | What is true |
| --- | --- | --- | --- |
| Sign up, sign in, Google sign-in, password reset | IMPLEMENTED BUT NEEDS PILOT VALIDATION | main | Single-use reset link that expires in 30 minutes. Emails have not yet been seen arriving in a real inbox from staging. |
| Terms of use and privacy notice | IMPLEMENTED BUT NEEDS PILOT VALIDATION | this PR | Terms version 2026-11-24 with section 13 "The pilot"; privacy covers offline storage and on-phone voice (ADR-068). Still marked draft until counsel reviews it. |
| Onboarding | PARTIAL | main | Business type, country, currency, time zone, first shop, and a home screen checklist (products, address, customer, staff, first sale). **Missing:** a payment-methods step and a tutorial. |
| Roles, staff, PINs on shop phones | IMPLEMENTED | main | Job functions with mapped permissions; shop phones with PINs and auto-lock. |
| Quick sale (cash, transfer, POS, credit) | IMPLEMENTED | main | Desk flow (sales desk → cashier → store keeper) is available. Below-list prices need a manager. |
| Typed items and the quick catalog | IMPLEMENTED | main | Items sold before they are products, matched to products by name later (ADR-041, ADR-049, ADR-052). |
| Voice sale on the phone | IMPLEMENTED BUT NEEDS PILOT VALIDATION | main, #61 | Experimental and switchable per business. Review is mandatory. Several sales in one recording come in #61. English only; not tried on real market speech. |
| Receipts and invoices (PDF, WhatsApp link) | IMPLEMENTED | main, #58 | "Paid in full" is removed in #58. Serial numbers print on receipts in #66. |
| Returns and swaps | IMPLEMENTED | main, #63 | A return time limit (owner can override) comes in #63. |
| Customers, credit, debtors, statements | IMPLEMENTED | main, #63 | Standard credit terms (due date set by itself, no comment needed) come in #63. |
| Sales by day; sales report by week, month and year | IMPLEMENTED | main, #62 | The report with a chart, top items, by shop and by staff, and a CSV, is in #62. |
| Money: expenses, cash per shop, cash counts, POS cash-out, profit | IMPLEMENTED | main | Profit comes only from sales (ADR-038) and is always shown (ADR-051). |
| Books (double entry) | IMPLEMENTED | main, #59 | Every money and stock path posts balanced entries. Missing accounts after a business changes type are added in #59 (blocker B1). |
| Bank statement matching | IMPLEMENTED | main | |
| Suppliers and what is owed to them | IMPLEMENTED | main | |
| Jobs for service businesses | IMPLEMENTED | main | Jobs need a network. |
| Products: items, variants, categories, brands, codes, units, packs | IMPLEMENTED | main | ADR-046. |
| Price lists and supplier prices, landed cost | IMPLEMENTED | main | ADR-048. |
| Stock in, counts, adjustments, transfers, warehouses | IMPLEMENTED | main, #60 | Warehouse cash is settled in #60. |
| Attributes, batches and expiry, serials and IMEIs, reorder rules | IMPLEMENTED | #64–#67 | Each is off until switched on per product, so simple shops see nothing new. |
| Product files in and out; camera scanning; fast search | IMPLEMENTED | #69–#71 | Scanning needs a browser with a barcode reader (Chrome on Android). |
| Offline: sales, stock in, counts, customers, payments | IMPLEMENTED BUT NEEDS PILOT VALIDATION | main | Kept through failures, reloads and tabs, sent once, kept in their shop (ADR-044, ADR-050). Not tried on real phones. |
| Offline: new products, stock changes, count lines | IMPLEMENTED BUT NEEDS PILOT VALIDATION | #68 | Counts are compared with the stock at the time counted. |
| Offline: expenses, money moves, cash counts, returns, jobs, photos | NOT IMPLEMENTED | | These need the network, and say so on the screen. |
| Small screens | IMPLEMENTED BUT NEEDS PILOT VALIDATION | main, #72 | Checked at 320 and 360 px in the browser. Not tried on real phones. |
| Low bandwidth | IMPLEMENTED BUT NEEDS PILOT VALIDATION | main | Quick sale is within its 170 kB budget. The voice download can be stopped, retried and removed. Not tried on real 3G. |
| Records export | IMPLEMENTED | main | ZIP of CSV files, owner and administrators, audited. |
| Card and online payments | NOT REQUIRED FOR PILOT | | Locked off. Payments are recorded as cash, transfer or POS. |
| Ask Zora and other AI agents | NOT REQUIRED FOR PILOT | | Nothing acts on anyone's behalf. |
| Advanced accounting and tax calculations | NOT REQUIRED FOR PILOT | | Locked off. The Terms say Bizora is not accounting or tax advice. |
| Plans and billing | NOT REQUIRED FOR PILOT | | Limits are off for every business. |
| Languages other than English | NOT REQUIRED FOR PILOT | | |

## B. Running the pilot (readiness items 1–30)

| # | Item | Label | Where | What is true |
| --- | --- | --- | --- | --- |
| 1 | Documents match the product | IMPLEMENTED | main, this PR | README, architecture, deployment and the pilot documents; inventory status in #72. |
| 2 | Readiness checklist and check script | IMPLEMENTED | main, this PR | `PILOT_READINESS_CHECKLIST.md` in four sections, each gate linked to its test; `scripts/pilot-readiness-check.ts`. |
| 3 | Email provider | IMPLEMENTED BUT NEEDS PILOT VALIDATION | main | Retries with an idempotency key; masked logs; production refuses the console provider. No real inbox yet (B6). |
| 4 | Password reset | IMPLEMENTED BUT NEEDS PILOT VALIDATION | main | Delivery to a real inbox not yet checked. |
| 5 | PostgreSQL row-level security | NOT IMPLEMENTED | ADR-043, issue #43 | Gated before general availability. Instead, a blocking matrix probes every route as another business and fingerprints every table. |
| 6 | Tenant isolation matrix, blocking in CI | IMPLEMENTED | main | Every new `:id` route in #58–#72 is in it. |
| 7 | Financial integrity suite | IMPLEMENTED | main | |
| 8 | Idempotency | IMPLEMENTED | main | Every offline operation and every void, approval and cancellation. |
| 9 | Offline hardening | IMPLEMENTED BUT NEEDS PILOT VALIDATION | main, #68 | |
| 10 | Voice | IMPLEMENTED BUT NEEDS PILOT VALIDATION | main, #61 | False confidence 22–36% on clean recordings, so review stays mandatory. |
| 11 | Android device matrix | PARTIAL | main | 320 and 360 px checks done in the browser. **Not done:** real phones (B8). |
| 12 | Low bandwidth | IMPLEMENTED BUT NEEDS PILOT VALIDATION | main | |
| 13 | Upload and storage safety | IMPLEMENTED | main | Real PNG or JPEG only, with size and count limits. Files are not virus-scanned. |
| 14 | Export, backup and restore | PARTIAL | main | Export done. Backups configured but not confirmed (B5). Restore drill never run (B7). |
| 15 | Support access audit | IMPLEMENTED | main | |
| 16 | Admin portal hardening | IMPLEMENTED | main | |
| 17 | Pilot telemetry and measures | IMPLEMENTED | main | Gap: voice downloads from Settings are not counted. |
| 18 | Feature switches per business | IMPLEMENTED | main | |
| 19 | Sample data | IMPLEMENTED | main | |
| 20 | Onboarding in business language | PARTIAL | main | See section A: no payment-methods step, no tutorial. |
| 21 | Plain error messages | IMPLEMENTED | main | Every new error in #58–#72 is in plain words. |
| 22 | Staging validation and runbook | PARTIAL | main, this PR | Runbook written, with support escalation added. Staging not validated (B3–B9). |
| 23 | No payment gateways | NOT REQUIRED FOR PILOT | | Locked off. |
| 24 | No AI agents | NOT REQUIRED FOR PILOT | | Confirmed absent. |
| 25 | Pilot terms and privacy | IMPLEMENTED BUT NEEDS PILOT VALIDATION | this PR | Terms section 13 and privacy paragraphs; counsel review still needed before general availability. |
| 26 | Security review | IMPLEMENTED | main | S-3 (Medium) needs staging (B4). |
| 27 | Dependency review | IMPLEMENTED | main | |
| 28 | Performance baseline | PARTIAL | main, #71, this PR | Local measurements: 10,000 sales and 5,000 customers; sign-in, search, stock lookup, reports and five shops (this PR); 50,000 products (#71). Not on staging (B9). |
| 29 | Support tooling and escalation | IMPLEMENTED BUT NEEDS PILOT VALIDATION | main, this PR | Admin portal tools; the escalation path is in the runbook (step 15). The person and the WhatsApp number must be named (B10). |
| 30 | Tag `v0.9.0-pilot` | NOT IMPLEMENTED | | Not tagged: the blockers in the report's section 15 are open. |
