# ADR-048: Price lists, suppliers per product, last cost and delivery charges

## Status

Accepted on 23 Nov 2026. Inventory and catalog redesign, phase 4. Builds on ADR-014 (stock through one writer), ADR-029 (suppliers and what is owed) and ADR-018 (deliveries saved together). Migration `0042_price_lists_suppliers_landed_cost.sql`.

## Context

- Wholesalers and distributors sell the same product at more than one price: an everyday (retail) price, a wholesale price, a lower price from 10 bags, a price for one big buyer.
- A product can come from several suppliers, each with its own code for it, its own price and its own terms.
- Transport, clearing, loading and customs are part of what stock really cost. Without them, profit looks higher than it is.

## Decision

### Price lists

- **What a product's price means.** A product's own price stays its everyday price. A price list (`price_lists`) holds other prices.
- **What a price is.** Each price (`price_list_prices`) is for:
  - one product and one unit (the base unit or a pack);
  - a minimum quantity (from 1 by default);
  - optionally a start and an end date.
  - The same product, unit, minimum and start date is one price, which is changed rather than added again.
- **Where a list applies.** A list is in the business's currency and may be limited to one shop. It can be switched off.
- **Which list prices a sale:**
  - the list chosen at the counter;
  - else the customer's list (`customers.price_list_id`), for a sale made here and now;
  - else the everyday prices.
  - The sale keeps the list it was priced from (`sales.price_list_id`).
- **Which price is used.** The highest tier whose minimum the quantity reaches, on the sale's own day. Without a price on the list, the everyday price is used.
- **Choosing at the counter.** Staff without discount rights may choose a list only if the owner allows it (`staff_can_choose`). Selling below the list's price is still a discount, which needs a manager.
- **A customer's list that does not apply here** (switched off, another shop) is skipped quietly. A chosen list that does not apply is refused (`PRICE_LIST_NOT_HERE`).
- **Offline and typed-in sales** use only a list the sale names, never the customer's list on its own. The phone prices what the person saw, so the server prices it the same way, and a queued sale is never refused or overcharged. The quick sale names the list when it saves offline.
- **The sale screen.** `GET /api/v1/pricing/for-sale` gives the sale screen the prices the sale will use (no costs), so the total on the screen is the total of the sale.
- **Permission.**
  - A new permission, `pricing.lists.manage`, is given to owners, administrators and managers (fixed ID `…151`). It is needed to make lists, change prices and give customers a list.
  - Staff who sell see only the lists they may choose.
- **Past sales.** Prices already on sales never change. Every change to a list, a price or a customer's list is audited.

### Suppliers of a product

- **What a line holds.** `supplier_products` holds one line per supplier and product:
  - the supplier's code;
  - the last cost per base unit;
  - lead time, minimum order and the unit they sell in;
  - the last delivery.
- **The usual supplier.** At most one supplier is preferred per product (a partial unique index). Making one preferred clears the others.
- **How lines are added.** Lines are added the first time a supplier delivers the product, or by a manager of purchases.
- **Finding a product.** Searching for a supplier's code finds the product.
- **Business checks.** A supplier is checked to belong to the business, not just the tenant, because the suppliers foreign key is `(tenant_id, id)`.

### Last cost

- **What is kept.** Each product keeps:
  - `last_purchase_cost_minor`, the supplier's price per base unit;
  - `last_landed_cost_minor`, the same with charges;
  - `last_purchased_at`.
- **When it changes.** Only a cost someone entered counts. A delivery recorded later for an earlier day (an import, a photo of a book) does not replace a newer cost.
- **Who sees it.** Costs show only to people with `prices.cost.read`.

### Deliveries with charges (landed cost)

- **What is recorded.** `POST /api/v1/stock/receipts` records several products delivered together, with up to 10 charges: transport, clearing, loading, customs, freight, other. Each charge is paid from the drawer or the bank. It needs `stock.receive` and `purchases.manage`, because money goes out.
- **How charges are shared.** Each charge is spread over the lines by the goods' value with `spreadByWeight`: whole kobo, remainder to the largest fractions, so the parts add up exactly. The same function runs on the screen.
- **What each movement holds.** Each line is an ordinary `received` movement through `StockService.applyMovement`. Its value is goods plus its share of charges, so the weighted average cost and profit include the charges. The movement records `charges_minor` and `receipt_id`.
- **Books.**
  - Debit: stock for goods plus charges.
  - Credit: the goods account (cash, bank or what is owed to the supplier) for the goods.
  - Credit: cash or bank for each charge share.
  - The entry always balances.
- **What the supplier is owed.** Only the goods, never the charges.
- **All or nothing.** A delivery saves together or not at all. Sending it again with the same ID returns the same delivery.

## Consequences

- **Wholesale and big-buyer prices** work without changing a product's everyday price, and the sale screen shows them.
- **Profit** now includes delivery costs where they are recorded.
- **Not done in this phase:**
  - price lists in another currency;
  - customer groups;
  - charges added after the goods were received;
  - a list chooser on the cashier's desk screen.
- **Merging after #48.** This phase was built against main while #48 (catalog items) and #49 (transfers) are open. The product search line and the Stock page links touch the same places, so this branch needs a small rebase after those merge.
