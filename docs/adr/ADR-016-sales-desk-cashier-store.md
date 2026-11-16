# ADR-016: Sales desk, cashier and store keeper

## Status

Accepted. Implements Spec Addendum v1.2 roadmap Sprint 5b. Builds on ADR-011 (roles), ADR-013 (ledger), ADR-014 (stock) and ADR-015 (sales).

## Context

Many Nigerian wholesale shops and larger stores separate three jobs:

1. A sales person serves the customer and writes the sale.
2. The cashier takes the money or approves credit.
3. The store keeper gives out the goods against the receipt.

No single person can both take money and release goods, which protects against theft. Small shops and kiosks still need the one-step sale from ADR-015.

## Decision

### A choice per business

`businesses.sales_flow` is `simple` (default, ADR-015) or `desk`. The owner changes it under Settings → Shop ("How you sell"). Imported sales are past records and always use the simple path.

### Stages

| Status | Who acts next | What has happened |
| --- | --- | --- |
| `awaiting_payment` | Cashier | The sales person recorded the items, the customer and what the customer said they will pay with (`requested_payment`). The sale has its receipt number. No money, stock or ledger. |
| `awaiting_release` | Store keeper | The cashier took payment or gave credit. The money and revenue are posted (Dr cash/bank/POS/debtors, Cr sales). |
| `completed` | — | The store keeper gave out the goods. Stock leaves now and cost of goods is posted (Dr cost of goods, Cr stock). |
| `voided` | — | Cancelled at any stage. Whatever had happened is reversed. |

- Revenue is recorded when the cashier finishes, and stock when the goods leave, so stock always matches the shelf.
- Between the two steps the sale has revenue but no cost of goods yet; the gap closes when the goods are given out.
- Database checks enforce the stages:
  - unpaid sales have nothing paid and no collection time;
  - completed sales have been released;
  - before the cashier, the whole total is unpaid and no customer is needed.
- Each step locks the sale row (`SELECT … FOR UPDATE`) and refuses the wrong stage (`409`), so two cashiers cannot take the same payment.
- The `sales.collect` and `sales.release` endpoints are idempotent.

### Credit

- Only managers and owners (`debtors.manage`) approve a customer for credit and set a limit (`customers.credit_allowed`, `credit_limit_minor`; empty means no limit). They can do this when adding the customer or later on the customer's page (`PATCH /customers/:id/credit`). Each change is in the activity log.
- To give credit (in both flows) a person needs `sales.credit` (Cashier, Manager, Owner) or `debtors.manage`, plus:
  - a customer approved for credit;
  - a due date, not in the past;
  - a comment (saved as a `credit` comment).
- Cashiers stay within the limit. Managers and owners may go over it, which is written in the activity log.
- What a customer owes is the sum of open credit sales until debtor payments arrive (Sprint 6).
- Existing customers who already had credit sales were approved by the migration, so nothing breaks.

### Who sees what

| Person | Sees |
| --- | --- |
| Sales person | Their own sales, in full. May cancel their own sale while it waits for payment. |
| Cashier (`sales.collect`) | Sales waiting for payment in their shop and the ones they handled, in full. |
| Store keeper (`sales.release`) | Sales waiting for goods in their shop and the ones they gave out, **without amounts or customer** (the "release" view). |
| Manager, owner | Everything (`sales.read.all`). |

### Comments and notifications

- `sale_comments` cannot be changed or deleted (trigger). Anyone who can see a sale can comment; the comment records the person and their job.
- `notifications` are per person (membership). They hold the kind, the sale and who acted, and never amounts or customers.
  - Cashier finishes: the sales person and the shop's store keepers are notified (`sale.paid` or `sale.credit`).
  - Goods given out: the sales person and cashier (`sale.released`).
  - Comments and cancellations: the others on the sale.
- The app shows a bell with the unread count, checked every minute and when the app comes back to the screen. Home shows the cashier's and store keeper's waiting lists.

### Permissions (migration 0017)

| Permission | Granted to |
| --- | --- |
| `sales.collect` | Owner, Administrator, Manager, Cashier |
| `sales.release` | Owner, Administrator, Manager, Storekeeper |
| `sales.credit` | Owner, Administrator, Manager, Cashier |

## Consequences

- Taking money and giving out goods are separate duties when the business wants them to be.
- Collecting and releasing need the network. Recording the sale works offline (ADR-012), and the sale reaches the cashier when it syncs.
- Phone (web push) notifications and WhatsApp alerts are later work. Today notifications are inside the app.
- Partial release (giving out some of the goods now) is not supported. The whole sale is released at once.
