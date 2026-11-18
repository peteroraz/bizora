# ADR-031: Transfers wait for confirmation; the discounts and cancellations report

## Status

Accepted on 18 Nov 2026 (Sprint 7e). Completes review items 12–16 with ADR-028 to ADR-030.

## Context

At the counter, a customer shows a transfer alert on their phone and walks away with the goods. Fake alerts and transfers that never land are a common loss. Until now a transfer counted as money in the bank the moment it was recorded (ADR-028 noted this).

Owners also had no single place to see where money left at the counter, and who did it: discounts, lowered prices, cancelled sales, returns and cancelled payments. The roadmap calls this the discounts/voids report.

## Decision

### Who confirms

Only the people who can see the bank (`bank.reconcile`: owner, administrator, accountant) confirm transfers. No new permission was added.

- **Staff transfers wait.** A transfer recorded by anyone else (cashier, sales staff, manager), on a sale or as a later payment from a customer who owes, is held as **waiting**.
- **Their own count straight away.** A transfer recorded by someone who can confirm counts at once.
- **Typed-in sales.** Sales typed in from an old book or a photo count straight away.
- **Who is told.** Everyone who can confirm gets a notification ("… recorded a transfer for R-000123. Check your bank and confirm it.").

### Where the money sits

New account **1160 "Transfers waiting for confirmation"** (asset). A waiting transfer is posted there instead of to the bank (1100).

| What happens | Entry | Effect on the sale or customer |
|---|---|---|
| It came in (by hand) | Dr Bank · Cr Transfers waiting | none |
| A bank statement line matches it (ADR-020) | Dr Bank · Cr Transfers waiting, dated the statement line | none |
| It never came, the customer owes it (sale with a customer) | Dr Customers who owe · Cr Transfers waiting | Paid goes down and still owed goes up, so the customer shows in Debtors |
| It never came, written off | Dr **6960 "Transfers that never arrived"** (expense) · Cr Transfers waiting | none; profit shows the loss |
| A later payment from a customer who owes never came | The payment is cancelled (its entry reversed) | They owe it again |

- **The record.** `sale_payments` and `customer_payments` gain `confirmation` (`confirmed`, `waiting`, `not_received`), with how it was confirmed (`by_hand` or `bank_statement`), who, when, the entry and a note. A check constraint allows waiting only on transfers. Every payment from before counts as confirmed.
- **Whoever took the payment** is told when it never came, so they can talk to the customer.
- **Undoing a bank statement match** puts the transfer back to waiting.
- **Cancelling a sale or payment** whose transfer was confirmed by hand also undoes the confirmation, so the money comes back out of the bank. If the transfer was confirmed by a bank statement, the line is unmatched first (`MATCHED_TO_BANK`).
- **Bank statement suggestions** skip transfers marked as never received.

### Screens

- **Transfers to check** (Money): each waiting transfer with amount, sale or payment number, customer, who recorded it, when, the shop and the reference. Buttons: "It came in" and "It never came" (customer owes it / write it off, plus what happened). Below it, the last 20 checked.
- **Where the owner is told:**
  - a Money card with the count and total;
  - a Home line ("2 transfers to check against the bank");
  - a notification that opens the list.
- **A sale's page** marks a transfer "Waiting for the owner to check the bank", or that it never came.

### Discounts and cancellations

`GET /money/discounts-cancellations` covers a day or a month, by shop, with `reports.profit.read`, the same people who see profit. It lists:

- **Discounts:** the discount off the total plus prices lowered below the list price, on sales that still stand, by the person who made the sale.
- **Cancelled sales:** with the reason, who sold it, who cancelled it, and whether it had been paid.
- **Goods taken back** (ADR-030).
- **Payments cancelled by hand.**
- **Transfers that never came:** shown against the person who took them.
- **Totals for each, and totals per person.**

## Consequences

- **The owner's own transfers are not double-checked.** A business that wants that too would need a setting; none is built.
- **Receipts and invoices** still show a transfer as paid while it waits. The customer has paid, as far as the counter knows.
- **Confirming needs a network**, like other money actions.
- **Each list in the report** shows at most 200 rows for the period. The totals cover the rows shown.
