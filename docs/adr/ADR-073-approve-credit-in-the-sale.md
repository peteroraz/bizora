# ADR-073: Approve a customer for credit inside the sale

## Status

Accepted on 26 Nov 2026. Builds on ADR-015 (credit needs an approved customer), ADR-016 (desk flow) and ADR-059 (standard credit terms).

## Context

The app review (26 Nov) sold on credit as Bisi, an owner who runs her stall alone. Her new customer was refused with "not approved for credit. A manager or owner can approve them on the customer's page." She *was* the owner. She had to leave the sale, open the customer, approve credit, come back and start the sale again. Then she still had to write a comment. At a busy stall, that credit sale does not get recorded.

## Decision

- When an owner or manager (`debtors.manage`) sells on credit to a customer who is not approved, the credit card on the sale says so and offers **Approve {name} for credit**. It is the same on the cashier's collect screen in the desk flow.
- The sale sends `approveCredit: true`. The server approves the customer in the same transaction as the sale:
  - It needs the same permission as the customer's page.
  - It writes the same `customer.credit_changed` audit entry, with the sale's id.
  - The customer stays approved.
  - If the sale fails, nothing is approved.
- The approval stands in for the credit comment. If the owner writes none, the sale's credit comment is "Approved for credit at this sale." A comment they write is kept.
- Staff without `debtors.manage` see the old message, and the server refuses `approveCredit` from them with FORBIDDEN. Customer approval stays a manager's decision.
- Offline sales may carry the approval. The permission is checked when the sale syncs. Imported and captured records skip approval checks as before.
- Credit limits, due dates and standard terms are unchanged.

## Consequences

- An owner can give credit to a new customer in one tick.
- Every approval is still in the audit log, now linked to the sale that caused it.
- The existing refusal for unapproved customers is unchanged when the box is not ticked.
