# ADR-050: An offline sale is never lost

## Status

Accepted on 24 Nov 2026. Builds on ADR-034 (offline exceptions), ADR-044 (the shop on each queued change) and ADR-049 (a typed name that is a product). Migration `0044_offline_sales_kept.sql`.

## Context

A sale made with no network is already in the drawer. If the price, the credit approval or the shop changed before the phone could sync, the server refused the sale. The phone then offered to delete it. The cash stayed; the sale did not.

## Decision

- The phone sends the price it showed on every product line of a sale saved offline, and the exact line total when the seller typed one. A live sale still sends a product price only when the person may change it.
- An offline sale keeps that price, even when it is below today's price or a price list. The owner is told (`sale.below_price`), the same way other offline exceptions are marked. A live sale is still checked.
- An offline credit sale keeps a due date that is now in the past, and credit for a customer who is no longer approved or who is over their limit. The owner is told (`sale.credit_offline`). A missing comment is saved as "Sold offline". A balance with no customer, or payments over the total, is still refused.
- A sale for a shop that was closed after the sale was made is recorded in that shop, at the sale's own time, and the owner is told (`sale.closed_shop`).
- If a `sale.create` from a phone is still refused, it is stored in `sync_problems`. The owner and managers see it under Sales → "Sales that need you", and can record it (as an offline sale, at the phone's prices and time) or say it was not a sale, with a reason in the activity log. The phone's button reads "OK, the owner will see it" and removes the sale only after the server says it holds a copy.

## Consequences

- Typing a name that is not a product still just works. Nothing in quick recording got harder.
- A second sync of an operation the owner has recorded is a duplicate, so the sale exists once.
