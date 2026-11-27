# ADR-074: Imported and scanned sales add new items

## Status

Accepted on 28 Nov 2026. Builds on ADR-015 (check before saving), ADR-018 (AI capture is checked by a person) and ADR-049 (remembered items and products).

## Context

A shop imported a page of sales from its sales book. Every row was refused: "HP ProBook laptop Motherboard repair is not in your products. Add it first, or import this sale as history." The owner had to add each item by hand, then import again. The owner asked that items not in stock be added as new products, at the price they last sold for, and that the price can be changed like any other.

## Decision

- **The check finds new items.** Each item in the rows that is not a product is listed once, under "N items are not in your products". It shows the most recent price it sold for (the latest date, then the lowest row) and that sale's unit.
- **Product, service or typed.** The owner or a manager chooses for each:
  - **Add as a product.** It is added at that price, with no cost, and without counting stock. Past sales never make up a stock balance (ADR-049). The owner turns on "Count stock for this product" and enters a quantity when ready.
  - **Add as a service.** It never counts stock. Names with words like *repair*, *fix*, *service*, *labour*, *installation* or *wash* are suggested as services. Everything else is suggested as a product.
  - **Keep as a typed item.** As before: refused for a sale that counts, kept for a history row.
- **Only what a person chose is added.** The check suggests. A save adds only the items named in the request's `newItems`, so a person has seen every product the import adds. That matters for scanned pages and voice notes, where the words come from AI (ADR-018). A save that names nothing keeps unknown items typed.
- **Who.** Only people with `catalog.manage` (owner, administrator, manager) add items. For anyone else, new items stay typed and the box says a manager or owner can add them.
- **Matching.** An item matches a product written with other spacing or case, or with a full stop at the end, or one of the product's other names. An existing product with a similar name is pointed out ("Looks like Rice 50kg, already in your products"), but the import does not change the trader's rows.
- **Units.** A new product is counted in the unit of its latest sale. A counted sale of it in another unit is refused with a plain message. History rows keep any unit.
- **History rows** add new items too. Their sales still change neither stock nor the accounts.
- **Remembered items.** A typed item already remembered under the same name is linked to the new product, with its other names (the same step as upgrading it by hand).
- **Price.** The added price is an ordinary product price: the owner changes it on the product page, and the change is in the product's history.
- New items are added together in one transaction before the sales are saved.

## Consequences

- An owner can import a sales book from before Bizora in one pass.
- Products added this way have no cost. Their sales show as "no cost recorded" until a cost is entered (ADR-051 addendum, 26 Nov), so profit is not overstated.
- A badly read name from a photo can still become a product if the owner saves it without reading the box. The box lists every new item, and a product can be renamed or archived.
