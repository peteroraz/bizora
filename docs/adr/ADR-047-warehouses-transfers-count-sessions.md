# ADR-047: Warehouses, transfers with a lifecycle, count sessions and stock on the way

## Status

Accepted on 23 Nov 2026. Phase 3 of the inventory and catalog redesign (`docs/inventory/GAP_ANALYSIS.md`). Builds on ADR-014 (movements and average cost) and ADR-034 (approvals). Independent of ADR-046.

## Context

The brief asks for:
- stock in warehouses as well as shops;
- transfers that are requested, approved, dispatched, in transit and received, where the destination never rises before it is received;
- count sessions with lines and a lifecycle;
- stock status: available, in transit and so on.

Today a transfer writes its out and in movements at the same moment, and a count covers one product at a time.

## Decision

### Warehouses are branches

- `branches.kind` is `shop` (default) or `warehouse` (migration 0041).
- **What a warehouse shares with a shop:** balances, movements, permissions per shop, the offline copy and reports all work unchanged.
- **What differs:** a warehouse cannot make a live counter sale (`WAREHOUSE_NO_SALES`). Offline and imported sales already happened elsewhere, so they are not refused.
- **Where it is set:** in Settings › Shops, when a place is added or later.
- **Deferred:** sub-locations inside a branch (a back shelf), which the gap analysis leaves for later.

### Transfers

- **Tables:** `stock_transfers` and `stock_transfer_lines`.
  - Composite keys to the business and products.
  - The sender and receiver must be two different places.
  - Each transfer has a TR number.
- **Lifecycle:**

| Status | What happened | Stock |
| --- | --- | --- |
| requested | Someone who cannot adjust stock asked for it (ADR-034) | unchanged |
| approved | A manager approved it, or someone who may adjust stock made it | unchanged |
| dispatched | The sending place sent it | `transfer_out` at the sender, at average cost. The stock and its value are **in transit**, in neither balance. |
| received | The receiving place received it | `transfer_in` at the receiver, at **exactly** the value that left |
| cancelled | Withdrawn before it was sent | unchanged |

- **Who does what:**
  - Asking and sending need `stock.transfer`.
  - Approving needs `stock.adjust`.
  - Receiving needs `stock.transfer` or `stock.receive`.
  - Staff kept to one shop send only from it and receive only into it. This is checked explicitly: the usual branch lookup would quietly use the person's own shop.
  - The asker, or a manager, may cancel.
- **Less arriving than sent:**
  - The full quantity sent is received at the value that left.
  - The shortfall is then removed as `adjusted` with reason `missing`, at its share of that value.
  - That posts a stock loss (Stock lost or damaged, 5100) through the usual removal. The books always show what happened.
  - More arriving than was sent is refused: the extra is recorded as stock in.
- **After sending:** a dispatched transfer cannot be cancelled. It is received (all, some, or none at all) so that the movements follow what happened.
- **The quick way stays:** `POST /stock/transfer` (sent and received in one step) now also writes a `received` transfer with its line. Every transfer has one history.
- **The books:** transfers post nothing, because the stock stays in the Stock account the whole time. Total stock value is the same before, during and after (tested).

### Stock on the way

- A product's page shows, for each place, stock **on the way in** and **sent and not yet received**.
- A place with nothing yet but stock on its way is listed too.
- **Deferred:** "reserved" (no reservations exist yet), "incoming" from purchase orders (none exist yet), and "damaged" or "expired" as separate quantities. Today these are reasons on removals, not separate balances.

### Count sessions

- **Tables:** `stock_count_sessions` (one place, a name, status) and `stock_count_session_lines`.
- **Lines:** one line per product per session, holding the expected quantity, the counted quantity, the difference, the reason, the counter, the device and the time. Counting a product again replaces its line.
- **Lifecycle:**
  1. **Counting.** Needs `stock.count`.
  2. **Submitted.** Lines can no longer change.
  3. A manager (`stock.adjust`) either **sends it back** with a reason, which returns it to counting, or **approves** it, which **posts** it.
  4. **Cancelled** is possible at any point before posting.
- **Posting:**
  - Each non-zero difference becomes a `counted` movement, with the line's reason and the session name in its note. `count_id` holds the line's ID.
  - The difference found at counting time is what is applied, even if sales happened since, as single counts already work (ADR-014).
  - Nothing already recorded changes.
- **Reasons:** `count_correction` (the default when a difference has no reason), `damaged`, `missing`, `expired`, `other`.

### Movement type names

The brief's movement names map onto the existing types (the column stays as it is, so history keeps its meaning):

| Brief | Bizora `movement_type` (reason) |
| --- | --- |
| OPENING_BALANCE | `opening` |
| PURCHASE_RECEIPT | `received` |
| SALE | `sold` |
| CUSTOMER_RETURN | `returned` (`customer_return`, `sale_void`) |
| SUPPLIER_RETURN | `supplier_return` |
| TRANSFER_OUT, TRANSFER_IN | `transfer_out`, `transfer_in` |
| ADJUSTMENT_IN, ADJUSTMENT_OUT | `adjusted` (`found`, `correction` / `other`) |
| DAMAGE, LOSS, EXPIRED | `adjusted` (`damaged`, `missing`, `expired`) |
| Count correction | `counted` |
| PRODUCTION_IN, PRODUCTION_OUT | `job_return`, `job_use` (jobs, ADR-035) |
| RESERVATION, RESERVATION_RELEASE | not yet |

## Consequences

- **Larger businesses:** they get separate asking, approving, sending and receiving.
- **Small businesses:** they tick "Send it now" and receive in one tap, or keep using the quick transfer.
- **Offline:** transfers and count sessions need the network for now; offline counting is in phase 6.
- **Tenant safety:** every new table has composite keys to the business, its branches and its products, and the tests cover cross-business access in the API and the database. After #44 merges, its isolation matrix must list the new routes.
