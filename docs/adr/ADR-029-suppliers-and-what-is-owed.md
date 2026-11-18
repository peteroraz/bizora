# ADR-029: Suppliers and what is owed to them

## Status

Accepted on 18 Nov 2026 (Sprint 7c). Part of review items 12–14.

## Context

Stock received on credit already credited "Suppliers we owe" (2000) in the ledger (ADR-013), but only as one total. The supplier was a free-text name on the stock movement. Owners could not see what they owed each supplier, what was late, or record paying one.

## Decision

### Suppliers

`suppliers` holds the businesses you buy from: name (unique per business, any capitals), phone checked by country (ADR-027), notes, and archived.

- **Finding or adding a supplier on stock in.** Stock in takes `supplierId`, or a name that is found or added. Storekeepers name suppliers this way without seeing any money.
- **Stock owed with no supplier named.** It goes to one "Supplier not named" per business, so nothing owed goes missing. The stock-in screen asks for a supplier whenever "Owed to supplier" is chosen.

### What is owed, line by line

`supplier_entries` keeps three kinds of line:

| Line | Effect on what is owed | Ledger entry |
|---|---|---|
| Purchase | Adds | Stock in on credit: Dr stock · Cr Suppliers we owe (already posted by the stock movement) |
| Opening | Adds | Owed before Bizora: Dr owner's money put in · Cr Suppliers we owe |
| Payment | Takes away | Dr Suppliers we owe · Cr the drawer, the bank, or the owner's money |

- **Each line points at its ledger entry.** So the suppliers' total always equals the "Suppliers we owe" balance; a test checks this against the trial balance.
- **Opening amounts and payments** can be cancelled by the owner (`expenses.approve`). Cancelling reverses the entry and keeps the line, marked cancelled.
- **An opening amount that has been partly paid** cannot be cancelled until the payment is cancelled.
- **A delivery is corrected through stock,** not here.
- **Paying more than is owed** is refused.

### Late payments

- **Pay-by dates:** a credit purchase or an opening amount may carry a pay-by date.
- **Order of payment:** payments settle the oldest amounts first.
- **What counts as late:** whatever is still owed on lines whose pay-by day has passed.
- **What is shown:** the next pay-by day.

### Who sees and does what

All permissions already existed; none were added.

| Permission | Allows |
|---|---|
| `stock.receive` | Supplier names, when receiving stock |
| `purchases.manage` or `money.read` | What is owed |
| `purchases.manage` (owner, administrator, manager) | Adding, changing and paying suppliers |
| `expenses.approve` | Cancelling a payment or an opening amount |

### Existing data

Migration 0026 turns the supplier names already typed on stock in into suppliers, and links those movements to them. It also writes a purchase line for every delivery already received on credit, under "Supplier not named" when there was no name.

- **The trigger.** Stock movements are append-only (0015, enforced by a trigger). The migration turns that trigger off only for filling in the new `supplier_id` column once, then turns it back on.
- **From now on,** new movements carry the supplier from the moment they are saved.

### Screens

- **Suppliers** (in More): what is owed in total and how much is late, every supplier sorted by what they are owed, a search box, and Add a supplier.
- **A supplier's page:**
  - what is owed, and when the next payment is due or how much is late;
  - Pay this supplier, with "Pay all", paid from the drawer, the bank or the owner;
  - Already owed before Bizora;
  - change details, or remove the supplier once nothing is owed;
  - Call and WhatsApp links;
  - the history: deliveries with what came, payments and amounts from before. Deliveries paid at the time are listed separately.
- **Stock in:** a supplier name list to choose from. When the stock is owed to the supplier, a supplier is required, and a "Pay by" date can be set.
- **Money:** a Suppliers card showing what is owed and how much is late.
- **Cash in the shops:** a "Suppliers paid in cash" line.

## Consequences

- **Delivery imports** (CSV, AI capture) carry supplier names into the same records. An imported row on credit with no supplier name goes under "Supplier not named".
- **Returning goods to a supplier** (a debit note) is not built. It belongs with returns (Sprint 7d).
- **Supplier payments need a network.** They are not saved offline, like expenses (ADR-028).
