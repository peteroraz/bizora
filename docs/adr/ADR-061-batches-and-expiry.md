# ADR-061: Batches and expiry dates

## Status

Accepted on 24 Nov 2026. Builds on:
- ADR-014 (weighted average cost);
- ADR-047 (transfers);
- ADR-048 (deliveries with charges).

Inventory brief section 16. Migration `0049_batches_expiry.sql`.

## Context

Pharmacies, food sellers and cosmetics shops have to know which stock expires when, and sell the oldest first. Until now Bizora counted stock per product and shop only. The brief asks for batches to be optional per product and invisible to businesses that do not need them.

## Decision

**A switch on the product.** "Keep batches and expiry dates" (`products.tracks_batches`) sits on the new product and edit forms, and only for stock that is counted. It is off by default, so nothing changes for anyone who leaves it off.

**Batches hold quantities, not value.** `stock_batches` holds one row per shop, product, batch number and expiry date:
- the date made;
- the supplier;
- the first received date;
- how much came in, and how much is left.

Stock value stays the weighted average of ADR-014, so the books, cost of sales and stock value do not change. `stock_movement_batches` records which batches each movement added to or took from.

**One writer.** `StockService.applyMovement` is still the only place stock changes. For a product that keeps batches, it also moves batch quantities, in the same transaction:
- **Stock coming in** (received, opening, returned, found, counted up) goes into its batch. A delivery with the same batch number and expiry adds to that batch. Stock with no batch details goes to a "no batch number" batch.
- **Stock going out takes the earliest expiry first.** Removing a named batch (taking expired stock off) takes only from that batch. If you ask for more than the batch holds, it is refused.
- **Sales and job use take stock that is within date first**, earliest expiry first.
- **A sale at the counter is refused** (`EXPIRED_STOCK`) when only expired stock would be left to sell. The message says how much is past its date and asks to remove it first. An offline sale, or one typed in from a book, already happened, so it is kept and takes from expired stock if it must. Offline transactions are never discarded.
- **Stock from before the switch was turned on** is in no batch. It still sells, and it counts as within date.
- **Transfers carry their batches.** Stock arriving at another shop goes into the same batch numbers and expiry dates it left with. Anything reported missing on arrival comes off the earliest expiry.

**Seeing it:**
- **The product page** lists the batches in this shop, earliest expiry first: "Expires 6 Dec 2026, 12 days left" or "Expired 21 Nov 2026, 3 days ago". An expired batch has a "Take off as expired" button, which records an `expired` removal for that batch (it goes to a manager when the person's changes need approval).
- **Stock in** asks for the batch number, expiry date and date made, only for these products.
- **The Stock page** shows a notice only when something is expired or expires within 30 days. It links to **Expiring stock** (7, 30 or 90 days).

**Routes:**
- `GET /api/v1/products/:id/batches`;
- `GET /api/v1/stock/expiring?days=` (0–365).

Both need `stock.read` and are scoped to the business and the shop, like every other stock read. Writes reuse the existing stock routes and their permissions; `batch` and `batchId` are optional fields on stock in, deliveries and removals.

## Consequences

- No new permission was added. The brief's `batch.manage` is covered by stock in (`stock.receive`) and removals (`stock.adjust`). A separate permission can be split out if a pilot needs one.
- The cost of a single batch is not tracked. Profit by batch would need batch-level costing. That is a later decision and would change stock values, so it needs an ADR of its own.
- Count sessions still count the product as a whole. A count that finds less takes the difference from the earliest expiry. Counting batch by batch can follow.
- A shelf location within a shop is not recorded. The shop is the location.
