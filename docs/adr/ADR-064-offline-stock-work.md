# ADR-064: Products, stock changes and count lines with no network

## Status

Accepted on 24 Nov 2026. Inventory phase 6, item 1. Builds on ADR-012 (the outbox), ADR-034 (stock requests), ADR-044 (offline work keeps its shop) and ADR-047 (count sessions). No migration.

## Context

Offline, a phone could already sell, record stock coming in, count one product, add a customer and record a payment. Three common jobs still needed the network:
- adding a product noticed on the shelf;
- taking damaged stock off;
- counting the shelves during a count session.

Counts had a second problem. An offline count was compared with the stock when it reached the server, not when it was made. Two bags sold between counting and syncing showed as two bags over.

## Decision

**Three new outbox types** go through the same sync push. Each still has its usual permission and shop checks, and its operation ID as the idempotency key:
- **`product.create`** (`products.manage`) makes the product with the ID made on the phone, so sending it again returns the same product. The new product page saves it on the phone when there is no network. The product is also added to the phone's product list at once, marked as waiting, so it can be found and sold there. The outbox sends work in the order it was done, so a sale of the new product reaches the server after the product. A photo, or a brand not yet on the list, needs the network, and the screen says so.
- **`stock.adjust`** (`stock.adjust` or `stock.count`) is the product page's take off / add back. A store keeper's change still becomes a request for a manager (ADR-034).
- **`stock.count_line`** (`stock.count`) is one line of a count session, with the session ID. The counts page shows it under the count as "Waiting to send" until it goes.

**A count is compared with the stock when it was counted.** `balanceAt()` is today's balance less every movement after the count time. It is used for count-session lines and single counts (`stock.count`) that come from a phone. The count time is the operation's `occurredAt`, limited by `countTime()`:
- a time in the future means now;
- the oldest it can be is a week ago, the same limit as an offline sale (ADR-050);
- a count-session line can be no older than the session's start.

So a wrong or changed phone clock cannot reach back to a time when more stock was there. The count keeps the time it was compared at.

## Consequences

- Approving a count still applies the difference found (ADR-047). With the expected quantity taken at the count time, sales made between counting and syncing are no longer reported as stock found or missing.
- A removal made offline that is more than the shop now has is refused when it syncs. It stays on the phone as refused and is never dropped (ADR-012), so the person can see it and record it again.
- Count sessions are started and submitted online. Only counting lines works offline.
