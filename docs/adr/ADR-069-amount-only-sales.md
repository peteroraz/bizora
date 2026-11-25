# ADR-069: A sale recorded as just an amount

## Status

Accepted on 25 Nov 2026. From the product direction brief, section 3 ("Quick amount sale"), and the design proposal of the same date.

## Context

Some traders moving from an exercise book will not type item names yet. They want to know what they sold today, and how much came in cash, transfer and POS. Until now every sale line needed an item: a product, a typed name (remembered as an item) or a service.

## Decision

### The line

- A sale line can be **just an amount**: `{ amountMinor, description? }` in the sale request. It has no item, quantity or price.
- It is stored as `line_kind = 'amount'` (migration 0053), quantity 1 piece, unit price and total equal to the amount.
- The description is what the seller typed ("Bread and drinks"), or "Sale" when they typed nothing. It stays on the line only: it is **never remembered as an item**, never matched to a product, and never offered as a suggestion.
- A database check keeps an amount line free of a product, a possible product, a stock movement and a cost.
- An amount line can sit beside product lines in one sale. Everything else about the sale is unchanged: payments, credit, discounts, receipts, cancelling, returns of the sale as a whole, offline sending and idempotency.

### Money and profit

- The books treat it as goods sold with unknown cost: Dr Cash, Bank (waiting transfer) or POS; Cr Sales (4000). For a service business, 4000 is Service income, as for any sale.
- No stock moves and no cost of goods is posted.
- Profit counts it in "sales with no cost" (ADR-049, ADR-051). The books' profit is shown as it always is; an estimate appears only where the owner has entered a cost for the period. Bizora never invents a profit for these sales.
- It counts in the day's totals by payment method and in the sales report totals. It is left out of the items sold and top items lists, because it is not an item.

### Who and where

- `businesses.amount_sales` (on or off). **Shops that existed before this change start off**, so nothing changes for them. **New shops start on.** The owner changes it under Settings → Setup ("Let me record just the amount"). Changing it reloads the app.
- When it is off, the server refuses an amount line with `AMOUNT_SALES_OFF` (403), including from a phone that was offline. The phone's copy stays in "Sales that need you" (ADR-050) rather than being lost.
- Anyone who can make a sale can record an amount. There is no separate permission, because the owner's switch already decides whether the shop allows it.
- The **Just the amount** button shows on the quick sale only in the simple flow and only before any item is added. At the sales desk the cashier takes the money, so amounts are not offered there.

### The screen

- A large amount box (focused at once), Cash, Transfer or POS, an optional "What was it for?", and **Record ₦3,500.00**.
- After recording, the pad stays open and empty for the next sale, with a line saying what was recorded and a link to the sale.
- With no network the sale is queued like any other sale, with a provisional number.
- The pad loads only when opened (and is fetched after the screen loads, for offline use), so the quick sale stays within its 170 KB script budget.

## Consequences

- A business can start with nothing but amounts and still see daily totals by payment method.
- Profit stays honest: amount sales are always "cost not known".
- Not done yet: suggesting "Add Ogbono to your items?" when the same description repeats. That needs real use to tune and is left for after the pilot.
- Tests: `apps/api/src/amount-sales.test.ts` (totals, books, stock, switch, database check, offline) and `apps/web/e2e/amount-sale.e2e.ts` (pad, offline, owner switch).
