# ADR-019: Debtors, payments and adding customers while selling

## Status

Accepted. Implements Spec Addendum v1.2 roadmap Sprint 6a. Builds on ADR-013 (ledger), ADR-015 (sales), ADR-016 (credit approval) and ADR-017 (documents). Sprint 6b adds bank statement upload and the reconciliation inbox.

## Decision

### What is owed

- A customer owes the sum of `balance_minor` on their credit sales that are not history-only and are waiting for goods or completed.
- There is no separate debtor balance to drift out of step: payments lower the sales' balances.
- Overdue means the sale's due date is before today in the business's time zone.

### Payments

- `customer_payments` (migration 0020) records each payment:
  - a `PAY-000001` number;
  - method (cash, transfer or POS), amount, reference and time received;
  - its ledger entry;
  - a receipt token.
- `payment_allocations` records which sales it paid, and how much of each.
- Recording a payment (`payments.record`: Cashier, Manager, Owner, Administrator) works in one transaction:
  1. Locks the customer's open sales.
  2. Applies the amount to the sale the person chose, or otherwise oldest due date first (sales without a due date last, then oldest sale first).
  3. Refuses more than is owed (`OVERPAID`): change comes from the drawer, and customer advances are not supported yet.
  4. Adds to each sale's `paid_minor` and lowers its `balance_minor`. The sale's own checks still hold.
  5. Posts Dr cash (shop) / bank / POS clearing, Cr debtors (`payment:{id}`).
  6. Writes `payment.recorded` to the activity log.
- The client sends a UUIDv7, so a retried or offline payment (`payment.record` sync operation) is recorded once. Payments more than 7 days old are refused.
- **Cancelling** (`debtors.manage`: Manager, Owner, Administrator) needs a reason. It reverses the entry and puts the amounts back on the sales. The payment stays, marked cancelled.
- A sale that has payments against it cannot be cancelled until those payments are (`409 HAS_PAYMENTS`), so money is never counted twice.
- Sales show "Paid later (PAY-…)" lines, and their invoices and receipts include them.

### Debtors screens

- **Debtors list** (`debtors.read`): total owed, overdue total, and customers most overdue first, with a filter for overdue only and a name search. Shop staff see debts from their own shop.
- **Customer account:**
  - unpaid sales with due dates and overdue marks;
  - payments, each with a receipt PDF to send;
  - a record-payment form, which works offline;
  - a WhatsApp reminder.
- **Who sees phone numbers:** cashiers see the last four digits, and the reminder opens WhatsApp's share sheet. Staff with `customers.read` get the customer's chat directly.

### Statement link

- `customers.statement_token` is a random token. `/s/{token}` shows the business name, the customer's name, what is owed and overdue, unpaid sales and recent payments, and offers a PDF. It shows no phone numbers, costs or internal IDs.
- The link is made the first time someone opens the customer's account.
- A manager can make a new one (`POST /debtors/:id/statement-link`); the old link stops working at once, for links sent to the wrong person.
- Payment receipts and statements are PDFs from the same renderer as sales documents.

### Adding customers while selling

- The customer picker on the sale screen and the cashier's collect form has **+ New or walk-in customer**: a name, and a phone number (empty means walk-in).
- New permission `customers.add` (migration 0020) goes to Owner, Administrator, Manager, Sales and Cashier.
- With only `customers.add`, the server takes the name, phone and walk-in flag and ignores everything else (email, tags, credit). The answer is the limited counter view.
- Cashiers still cannot list, open in full or edit customers, and new customers are never approved for credit.
- A phone number already saved returns `DUPLICATE_PHONE`, and the picker shows that customer to pick instead.
- With no network, the customer is created on the phone with a UUIDv7 and queued (`customer.create`) ahead of the sale that uses them.

## Consequences

- Debtors, sales and the ledger agree by construction. The debtors account in the trial balance equals the sum of open balances (tested).
- Advance payments and customer credit notes are not supported. Overpayment is refused, so they can be added later as their own records.
- Reminders are manual (WhatsApp links). Automatic reminders need the WhatsApp Business Platform (ADR-017) or Ask Zora (Sprint 7.5).
