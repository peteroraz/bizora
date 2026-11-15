# ADR-013: Accounting core and ledger

## Status

Accepted. Implements Spec Addendum v1.2 §18. Foundation built in Sprint 3C.5b, before stock (Sprint 4) and sales (Sprint 5), so they post entries from day one.

## Context

Profit, cash and balance reports must be trustworthy, and an owner's accountant must be able to rely on them. Traders never see accounting words; the UI says "money in", "customers who owe", and so on.

## Decision

### Double-entry ledger, enforced by the database

- **Tables:**
  - `ledger_accounts`: chart of accounts per business;
  - `ledger_periods`: monthly, open or locked;
  - `journal_entries` and `journal_lines`.
- **Composite tenant foreign keys everywhere.** Lines reference their entry and account through `(tenant_id, business_id, …)`, so a line can never point at another organization's or another business's account.
- **Balanced:** a deferred constraint trigger checks at commit that each entry has at least two lines and that debits equal credits. Each line is either a debit or a credit, never both or neither.
- **Immutable:** triggers refuse `UPDATE` and `DELETE` on entries and lines. Corrections are reversing entries (`reverses_entry_id`), and an entry can be reversed once.
- **Periods:** an entry's period is the month of its date. Posting into a locked month is refused, by the service and by a trigger, and a locked month cannot be reopened. Corrections go into an open month.
- **Source:** every entry records its source document (`source_type`, `source_id`: sale, payment, expense, stock movement, reconciliation).
- **Idempotent:** every entry has a `posting_key`, unique per organization. Posting the same key again returns the first entry, which makes postings safe during sync retries.

### One way in: `LedgerPostingService`

- Modules never write ledger rows. They call `post()` inside the transaction that saves their document, so the document and its entry commit together.
- Lines name accounts by role (`cash` for the shop, `sales`, `debtors`, `stock`, …) or by code (expense categories). Ambiguous or unknown accounts are refused.
- `reverse()` posts the mirror image. `lockPeriod()` closes a month. `trialBalance()` returns totals per account, optionally up to a date.
- Devices never post. Postings happen on the server when synced operations are applied (ADR-012).

### Chart of accounts

- There is a default template per business type (`chartOfAccountsTemplate` in contracts):
  - **Assets:** cash per shop (`1000-01`, `1000-02`, …), bank, POS and transfer clearing, transfers between own accounts, customers who owe, stock;
  - **Liabilities:** suppliers we owe, customer advance payments;
  - **Equity:** owner's money in, withdrawals, retained profit;
  - **Income:** sales or service income, discounts given, other money in;
  - **Cost of sales:** cost of goods sold, stock lost or damaged;
  - **Expenses:** by category, including market levies and dues, and bank and POS charges;
  - **Other:** exchange gains and losses.
- Service businesses get no stock or cost-of-goods accounts. Food businesses get "Cost of food and drinks sold" and cooking gas. Wholesalers get loading and offloading.
- The API creates a business's accounts when they are first needed (first posting or first read) and adds a cash account for each new shop. Existing businesses therefore need no backfill.
- Owner and accountant editing of the chart comes in Sprint 7.

### Money

- All amounts are `bigint` minor units in the business's base currency (NGN).
- A foreign-currency line also stores the original currency, the original amount and the rate the trader entered. The service checks that the naira amount equals original × rate (half-even rounding, `@bizora/money` `convert`).

### Stock costing: weighted average per product per shop (confirmed)

- Implemented in `@bizora/money` (`receiveStock`, `issueStock`, `averageUnitCost`), for Sprint 4 to use.
- Quantities are whole thousandths of a unit (`QUANTITY_SCALE = 1000`), so 0.5 kg is `500`. No floating point anywhere.
- Issuing stock removes value in proportion to quantity, rounded half up, and the last unit out takes whatever value is left. Stock value therefore never drifts from the ledger. For example, 3 units bought for ₦100.00 cost ₦33.33 + ₦33.34 + ₦33.33.
- Selling more than is on hand is allowed. The extra is costed at the last average (or a fallback cost) and flagged as negative stock (ADR-012).
- Weighted average was chosen over FIFO because it needs no batch tracking, suits fungible goods sold by carton, bag or kg, and is what traders and their accountants expect.

### Who sees it

- `GET /api/v1/ledger/accounts` needs `money.read`. `GET /api/v1/ledger/trial-balance` needs `reports.profit.read` (owner, administrator, manager, accountant, auditor).
- Full reports (profit & loss, balance sheet, cash flow, debtors ageing, stock valuation) come in Sprint 8.5.

### Out of scope

- Tax computation, tax returns and NRS e-invoicing.

## Consequences

- From Sprint 4, any feature that moves money or stock must post through `LedgerPostingService`, with tests that the trial balance stays balanced (addendum §19).
- Because entries are immutable, a wrong posting rule leaves wrong entries that must be reversed, never edited. Posting rules need careful tests before they ship.
- A locked month cannot be reopened. If accountants need reopening later, it will be a new ADR with an approval step.
