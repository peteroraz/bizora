# ADR-038: Profit comes only from sales; POS cash-outs

## Status

Accepted on 20 Nov 2026.

## Context

- **The bug.** On a new shop's first cash count, the cash already in the drawer was posted as "Cash short or over: over". That account is an expense account, so a surplus lowered running costs and showed up as profit. "Other money in", from the cash screen or from a bank line, also counted as profit.
- **The owner's rule.** Profit comes only from sales (cash, POS, transfer and so on). Cash in the shop should be explained by sales.
- **POS cash-outs.** Many shops, especially in Nigeria, give customers cash from the drawer when they pay on the shop's POS machine (Moniepoint, OPay and the like), and charge a fee. The cash given is not a cost and not a sale; only the fee is earned.

## Decision

- **Profit** = sales − discounts − returns − cost of goods sold + POS cash-out fees − running costs. Nothing else adds to it.
- **Money in that is not from sales** goes to a new liability account, `2190 Money in that is not from sales` (role `not_sales_money`). This covers:
  - a count with more cash than expected;
  - "Other money in" (`other_in`);
  - a bank line marked "Other money in".

  The profit page shows this amount separately, with a note that it is not counted.
- **Older records.** Count surpluses posted before this change (credits to 6950 from cash counts) and older "Other money in" (4900) are left out of profit in the same way. The ledger itself is not rewritten.
- **Shortages** still count as running costs ("Cash short or over"), because the money is gone.
- **"Move money" screen.** It no longer offers "Other money in". The API still accepts it, for phones that are offline.
- **POS cash-out** is a new money move, `pos_cashout`, recorded at `POST /api/v1/money/pos-cashouts` by anyone who takes money at the counter (`sales.collect`). It has the cash given, the fee, and how the fee was paid.
  - Fee added on the POS: Dr 1150 POS payments (cash + fee), Cr cash (cash given), Cr 4060 POS cash-out fees (fee).
  - Fee paid in cash: Dr 1150 (cash given), Cr cash (cash given − fee), Cr 4060 (fee).
  - Money on the POS waits in 1150 with POS sales until the bank or POS statement shows it.
  - The cash screen shows a "POS cash-outs" line.
  - The owner can cancel a cash-out, like other money moves.
  - The home screen and Money have a "POS cash-out" button.

## Consequences

- A shop's first count no longer creates fake profit. Profit can be lower than before for shops that relied on count surpluses or "Other money in".
- The money held in 2190 has no "explain it" step yet. A later change can let the owner move it to owner's money or to sales not recorded.
- Cash-outs paid by bank transfer (instead of the POS machine) are not covered. They would need the same confirmation step as transfers at sales (ADR-031).
- The POS provider's own charge is recorded from the statement as "Bank and POS charges", as before.
