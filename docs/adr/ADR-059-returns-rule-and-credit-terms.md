# ADR-059: A returns rule, and standard credit terms

## Status

Accepted on 24 Nov 2026.

## Context

The business test found two gaps:
- A phone shop takes goods back within 7 days, but Bizora had no time limit on returns.
- A wholesaler gives its big buyers 30 days, yet every credit sale needed a due date and a written comment typed in.

## Decision

### The returns rule

- **The setting.** The owner sets "Goods come back within N days" in Settings › Setup (`businesses.returns_within_days`, 1–365; empty means no limit).
- **Late returns.** Returns are already recorded only by owners, administrators and managers (`sales.void`). Past the limit, a return needs the owner or an administrator (`tenant.manage`); a manager is refused with `RETURN_TOO_LATE` and the number of days. The days are counted in the business's time zone.
- **On receipts.** The owner may print the rule on receipts (`returns_on_receipt`). It is a "Returns: Within N days of the sale" row in the receipt details. It is not on invoices.

### Standard credit terms

- **Who sets them.** A manager or owner (`debtors.manage`, the same people who approve credit) can give a customer allowed credit standard terms in days (`customers.credit_terms_days`, 1–365).
- **At the counter.** When money is left owing on a sale to that customer, the due date is filled in as today plus the terms, and the comment "On N-day terms." is added. Both are used only if the person didn't give their own. This works at the counter, at the cashier in the desk flow, and on the sale screen, which fills the date and makes the comment optional.
- **Everyone else** still needs a due date and a comment for every credit sale, as before.
- **When terms are cleared.** Terms are removed when credit is taken away, and every change is in the audit trail.

Migration `0047_returns_and_credit_terms.sql` adds the three columns with range checks.

## Consequences

- Wholesale credit at the counter takes one tap, with the same approval, limit and audit as before.
- An offline sale older than 7 days is still refused by the existing rule (`TOO_OLD`). #54 now keeps such a sale under "Sales that need you" instead of losing it.
