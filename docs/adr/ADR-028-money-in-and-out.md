# ADR-028: Money in and out, cash per shop, profit

## Status

Accepted on 18 Nov 2026 (Sprint 7b). This covers review items 12–14 in part: cash, expenses and profit. Suppliers and what is owed to them, returns, and transfer confirmation follow in later parts of Sprint 7.

## Context

Owners asked three questions daily that Bizora could not answer:
- how much cash should be in each drawer;
- what was spent;
- whether the day made money.

The ledger (ADR-013) already holds one cash account per shop, expense accounts per business type and every sale's cost of goods. The permissions existed but nothing used them: `expenses.record`, `expenses.approve`, `cash.close`, `cash.expected.read` and `reports.profit.read`.

## Decision

### Records and postings

Each record posts a balanced entry in the same transaction (ADR-013). Cancelling posts a reversing entry and keeps the record, marked voided, with the reason.

| Record | Entry |
|---|---|
| Expense paid from the drawer | Dr the chosen expense account · Cr cash at that shop |
| Expense paid from the bank | Dr expense · Cr bank |
| Expense paid by the owner personally | Dr expense · Cr owner's money put in |
| Owner puts money in | Dr cash · Cr owner's money put in |
| Owner takes money out | Dr owner's withdrawals · Cr cash |
| Cash paid into the bank | Dr bank · Cr cash |
| Cash drawn from the bank | Dr cash · Cr bank |
| Other money in | Dr cash · Cr other money in |
| Count short | Dr Cash short or over (6950, new) · Cr cash |
| Count over | Dr cash · Cr Cash short or over |

- **Categories.** Expense categories are the business's expense accounts with role `expense`, `bank_charges` or `materials`. Accounts the system posts to (cost of goods, stock lost, fx, cash short or over) are not offered. The new 6950 account reaches existing businesses through `ChartOfAccountsService.ensure`.
- **Dates.** An expense or money move may be dated up to a year back and never in the future. Locked periods still refuse postings.
- **Retries.** Each record carries an ID made on the device, so a retried request records once.

### Approval (separation of duties)

- **Owner and administrator** (`expenses.approve`): their expenses are recorded as approved.
- **Anyone else** (manager, accountant): their expenses are recorded and posted at once, because the money has left the drawer, but marked "waits for approval".
- **The owner then** approves it, or rejects it with a reason; rejecting reverses the entry.
- **Cancelling:**
  - whoever recorded an expense may cancel it while it still waits;
  - only the owner can cancel an approved one;
  - only the owner can cancel a money move.
- **Where it shows:** waiting expenses appear on Home's approval card and on Money.

### Cash per shop

- **How the figures are worked out:** `GET /money/cash?date=` reads each shop's cash account.
  - **Start of day:** the balance before the day.
  - **The day's lines,** grouped by what caused them: sales, debt payments, expenses, the owner, the bank, other money in, stock paid in cash, counts.
  - **Should be in the drawer:** the start of day plus the day's lines.
- **Who sees what:**
  - only people with `cash.expected.read` (owner, administrator, manager, accountant, auditor) see these figures;
  - shop staff see their own shop.

### Blind count

- **Who counts:** anyone with `cash.close`, including cashiers, can count a drawer.
- **The server:**
  - locks the shop so two counts cannot both read the same balance;
  - works out what was expected at that moment and stores it with the count and the difference;
  - posts any difference to Cash short or over, so the drawer starts again from what was counted.
- **What the counter is told:** a counter without `cash.expected.read` is only told the count was saved, never the expected figure or the difference. This keeps a cashier from pocketing a surplus they would otherwise know about.
- **Menu:** cashiers now see Money in the menu, for counting only.

### Profit

`GET /money/profit?from=&to=` (`reports.profit.read`) sums the income and expense accounts in the range from the ledger:

| Figure | Accounts |
|---|---|
| Sales | `sales`, `service_income` |
| Discounts given | `discounts` |
| Cost of goods sold | `cogs`, `materials` |
| Other money in | other income accounts |
| Running costs | every other expense account: running costs, stock lost, bank charges, cash short or over, fx |

- **Profit** = sales − discounts − cost of goods sold + other money in − running costs.
- **Range:** up to a year, with one line per day up to 62 days.
- **Expenses waiting for approval** are counted, because they are posted, and the number of them is shown.
- **Which day:** amounts count on their entry date. A sale cancelled later lowers the day it was cancelled.

### Screens

- **Money** becomes the hub: cash in the shops, today's profit, expenses (with the number waiting), money in or out, and bank statements. Each part shows only to those with the permission.
- **New screens:**
  - Expenses: the last 30 days with totals by category, plus a "Waiting for approval" tab with Approve and Reject;
  - Record an expense;
  - Cash in the shops: any day, with Count the cash per shop;
  - Count the cash;
  - Money in or out;
  - Profit: a day or this month, with day-by-day lines.
- **Home** now shows:
  - the cash in the drawers (on its existing card);
  - today's profit on the money card;
  - expenses waiting for approval on the approval card.

## Consequences

- **Online only.** Expenses, money moves and counts are not saved offline yet: the sync operation types do not include them. Recording happens at the back office more than at the counter. Offline recording can follow the payment pattern (ADR-019).
- **Cash only on the cash screen.** Bank and POS balances are not shown there. They come from bank reconciliation (ADR-020).
- **No receipt photos yet.** Expenses do not take receipt photos. AI capture (ADR-018) could fill this later.
- **No transfer confirmation yet.** Transfers still count as paid when recorded. Confirmation is the next part of Sprint 7.
