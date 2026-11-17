# ADR-020: Bank statements and the reconciliation inbox

## Status

Accepted. Implements Spec Addendum v1.2 roadmap Sprint 6b (§17). Builds on ADR-013 (ledger), ADR-015 (sales), ADR-018 (AI capture) and ADR-019 (debtors and payments). Sprint 7 adds money out.

## Context

Many traders are paid by transfer straight into their bank. Staff record some of these transfers at the counter, and some never get recorded. The owner or accountant needs to see every naira that came into the bank and say what it was, without counting money twice and without counting money moving between their own accounts as sales.

## Decision

### Upload

- `POST /api/v1/imports/statement` takes rows from a CSV, or from a PDF or photo read by AI capture (target `statement`). It uses the same check-then-save review as the other imports.
- Columns: date, description, reference, money in and money out. Bank column names are recognised: Narration, Credits, Debits, Money In, and others.
- Amounts accept ₦, NGN, commas, CR/DR and brackets, and are stored in kobo as bigint.
- Each line gets a fingerprint: a sha256 of the business, date, amount, reference, description and how many times that same line appeared in the file. It is unique per business, so uploading the same statement again adds nothing.
- Money out lines are skipped with a clear message.
- Tables (migration 0021):
  - `statement_imports` (one per upload, with counts);
  - `statement_lines`;
  - `statement_rules`.

### Matching

Suggestions are worked out when the inbox is opened, strongest first:

1. **A transfer already recorded** (a sale payment or a debtor payment by transfer): same amount, within 3 days in the business's time zone, not already linked to another line. If its reference appears in the bank line, the match is exact; otherwise it is likely. Matching one posts nothing new, because the money is already in the books.
2. **A saved rule** whose words appear in the description: exact.
3. **A customer who owes**, when their name is in the narration ("NIP CR/MAMA CHIKA/…"). The score ignores bank noise words. A full name is likely and part of a name is possible.

Exact suggestions are applied automatically on upload, inside a savepoint, so a failure leaves the line open instead of failing the upload. Likely and possible suggestions wait for one tap.

### What a line can be

| Kind | Books |
| --- | --- |
| Recorded payment | Nothing new; the line is linked to the payment (unique, so one payment matches one line). |
| Debtor | A `PAY-` payment for up to what they owe, through the normal payment service (oldest due first). Anything above goes Dr Bank, Cr Customer deposits (an advance), never income. |
| Advance | Dr Bank, Cr Customer deposits. |
| Money in | Unrecorded sales (Sales, or Service income for service businesses), owner capital (Capital) or other money in (Other income). |
| Money between own accounts | POS settlement (Cr POS clearing), cash paid in (Cr the branch's cash) or another own account (Cr Transfer clearing). Never income. |
| Ignored | Nothing; a reason is required. |

- Every post is Dr Bank (1100), dated with the bank date, posting key `statement:{line}:{id}`.
- "Always do this" saves a rule: words to look for, and what to do. Rules are unique per business and count how often they were used.

### Undo and audit

- Undo cancels the payment the match created, reverses any journal entry, and sets the line back to open. A database check keeps open lines free of links.
- Matches, undos, uploads and rule changes are written to the activity log (`statement.*`).

### Access

`bank.reconcile` is for Owner, Administrator and Accountant (migration 0021). Cashiers and managers take money; they do not check it against the bank. The permission also allows statement capture.

## Consequences

- One bank ledger account for all banks for now. Separate bank accounts, with their balances, come with Money in Sprint 7.
- Name matching is simple token overlap. A wrong suggestion costs one tap to skip or one Undo.
- Money out matching (expenses, supplier payments, transfers out) is Sprint 7.
