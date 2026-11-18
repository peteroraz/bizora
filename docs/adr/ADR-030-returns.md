# ADR-030: Goods returned by customers and sent back to suppliers

## Status

Accepted on 18 Nov 2026 (Sprint 7d). Part of review items 15–16.

## Context

A sale could only be cancelled as a whole (ADR-016). Traders take goods back every day: a leaking bottle, a wrong size, a customer who changed their mind. Some is swapped for something else. Some goes back on the shelf, and some is damaged. On the other side, goods that came wrong go back to the supplier, usually taken off what is owed (ADR-029 left this for this sprint).

## Decision

### Returns from customers

`POST /sales/:id/returns` takes the lines coming back (`saleLineId`, quantity in the unit the line was sold in, `backToStock`), how money goes back (`cash` or `transfer`) and a reason. Each return gets a number (`RET-000001`) and is append-only (`sale_returns`, `sale_return_lines`, trigger `bizora_append_only`).

- **What the goods are worth.** Each line is worth its share of the line total after the sale discount, in proportion to the quantity coming back. The last of a line takes whatever is left, so rounding never loses or adds a kobo.
- **Never more than was sold.** The quantity left on each line is what was sold less what already came back. Over-returns are refused.
- **Off what is owed first.** If the customer still owes on the sale, the return comes off that first. Only the rest is given back in money. `sales.returned_off_balance_minor` keeps the first part, so the sale still adds up: paid + still owed + taken off by returns = total (constraint `sales_amounts_ck`).
- **Back on the shelf or not.** Goods put back go in as a `returned` stock movement (reason `customer_return`) at what they cost when sold. Damaged goods are not put back, so their cost stays a cost.
- **Who.** Returns need `sales.void` (owner, administrator, manager), the same people who cancel sales. Cashiers and sales staff ask a manager.
- **Cancelling after a return.** A sale with returns can no longer be cancelled as a whole (`HAS_RETURNS`). The rest of the goods can still come back.
- **Swapping.** A swap is a return plus a new sale. "Start a new sale for this customer" opens a sale with the customer already chosen and a note naming the sale it replaces.

| Ledger entry | Debit | Credit |
|---|---|---|
| The goods' worth | Returns from customers (4150, new, income contra) | Customers who owe (the part taken off), the shop's drawer or the bank (the part given back) |
| Goods back on the shelf | Stock | Cost of goods sold |

### Goods sent back to a supplier

`POST /stock/return-to-supplier` takes the product, supplier, quantity and unit, and how it is settled:

| Settled by | Who | Ledger entry |
|---|---|---|
| Taken off what is owed (`owed`) | `stock.receive` (storekeepers too) | Dr Suppliers we owe · Cr stock |
| Cash back (`cash`) | `purchases.manage` | Dr the shop's drawer · Cr stock |
| Money back to the bank (`bank`) | `purchases.manage` | Dr bank · Cr stock |

- **Value.** Goods go back at the stock's average cost (ADR-013), the same value they leave stock at.
- **The supplier's record.** Taken off what is owed adds a "Goods sent back" line to the supplier (`supplier_entries.kind = 'return'`). The suppliers' total still equals "Suppliers we owe".
- **Refused:**
  - more than is on the shelf (`NOT_ENOUGH_STOCK`);
  - more than is owed (`MORE_THAN_OWED`), for which the money-back way is used instead.
- **Correcting it.** It is corrected in stock, not on the supplier page.
- **Document number.** Each one has its own (`SR-000001`).

### Reports

- **Profit.** Returns show as "Goods returned by customers" and come off sales: net sales = sales − discounts − returns.
- **Cash in the shops.** A "Money given back for returns" line.

## Consequences

- **Returns need a network.** They are not saved offline, like cancelling a sale.
- **History-only sales** (brought in from an old book) cannot take returns. Record a new sale instead.
- **Goods sent back to a supplier for something else** are recorded as a send-back plus a new stock in.
