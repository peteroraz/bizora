# ADR-053: Custom units, old typed lines, and a cash-out warning

## Status

Accepted on 24 Nov 2026. Builds on ADR-038 (POS cash-out), ADR-049 (quick catalog). Migration `0046_old_typed_lines.sql`.

## Context

Three small gaps showed up when a shop was run through a normal day.

A unit typed once, including a misspelling, was added to the shop's unit list immediately. The owner had no separate way to confirm a unit they actually sell in.

Sale lines with no product were labelled `service` when the quick catalog landed, unless the name already matched a remembered item. Typed goods that did not match yet were treated as services. Job bills and real services must stay services.

A POS cash-out larger than the cash the drawer should hold was saved with no question. The books should still record it when the person means to give the cash out.

## Decision

**Units.** A unit that is not one of the standard units is added to `business_units` only after it has been used on two different sales in that business. Two lines on one sale count as one use. The owner, or anyone with `catalog.manage`, can add a unit in Settings and it is saved at once. Adding the same code again turns a switched-off unit back on.

A unit that appears on any sale line cannot be switched off. The sale keeps the unit that was written on it. Standard units are unchanged and are not stored as custom rows.

**Old typed lines.** Migration 0046 sets `line_kind` from `service` to `quick` only when all of these are true: the line has no product, the sale is not a job and not an import, the sale is not history-only, the sale has a journal, and that journal does not credit service income. Those lines were goods. The books posted them to sales, not to service income.

Left as `service`: job-bill work, imported history, a sale that earned service income (a real service, or a services business whose income is all service income), and a sale that was never posted. A sale that mixes goods and a service is left alone, because one journal cannot say which product-less line was the service. New sales are unchanged: a remembered typed line is `quick`, a service is `service`, a product is `product`.

**POS cash-out.** `GET /api/v1/money/drawer-expected` returns the cash the person's own shop drawer should hold today. Whoever can record a cash-out can read that one number. The cash page still needs `cash.expected.read`. When the cash given to the customer is more than that figure, the screen asks: "The drawer should have {expected}. Give out {amount} anyway?" Saving stays disabled until they tick it. `POST /api/v1/money/pos-cashouts` still records the cash-out, including an amount above the drawer.

## Consequences

- A one-off unit never joins the list. After the second sale it does, on every phone that loads units.
- Switching off a used unit is refused with "This unit is on a sale, so it stays in the list."
- Relabelled lines are goods with no cost until someone records one. Profit and the top-items list treat them as goods.
- A cashier can see the expected drawer cash on the cash-out screen, and only there. They still cannot open the cash page.
- The server does not reject a cash-out above the drawer. The question is on the screen.
