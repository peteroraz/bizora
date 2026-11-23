# ADR-049: Record a sale first, organise the list later

## Status

Accepted on 23 Nov 2026. Builds on ADR-041 (typed items). Migration `0043_quick_catalog.sql`.

## Context

A small shop should record "2 cups of Ogbono, ₦2,000, cash" without first creating products, prices, stock, categories, suppliers, SKUs or barcodes. Bizora should remember that item for the whole business, suggest it next time, and let the owner turn it into a stocked product later. The sale itself must stay as it was recorded.

ADR-041 already stored one remembered row per business per name (`saved_items`), with the last price and how often it sold. That row lived on the server, with a copy on the phone. What was missing was a shared search, other names, a name-only list, custom units, a way to turn the item into a product, and an honest profit figure when the cost is unknown.

## Decision

Remembered items stay on `saved_items`. They are not a second catalog and not a second way to sell.

- **Quick and managed are internal.** A remembered item is `catalog_mode = quick` until it is linked to a product, when it becomes `managed`. The screens never use those words. A quick item does not track stock, and past sales are never turned into a stock balance.
- **One name per business.** The key is the name trimmed, with spaces collapsed, trailing punctuation removed, and lowercased. "Ogbono." and "ogbono" are one item. "Peak Milk 400g" and "Peak Milk 900g" stay separate. A unique key on `(tenant_id, business_id, name_key)` stops a retry or two phones from creating two rows. An alias is resolved before insert, so a name that was merged away does not come back as a new item.
- **Other names** live in `item_aliases`, pointing at either the remembered item or, after it is upgraded, the product. Search and voice matching use them. They are never chosen on their own.
- **Units.** Standard units stay. A shop can add a short code such as `cup` or `mudu` in `business_units`. Selling in that unit remembers it. No conversion is required for a remembered item.
- **A new business** can sell typed items and products (`sales_items = both`). Remembering items and adding a name list are on. An existing shop that only sells from its product list stays that way. The owner can turn each of these off.
- **Who can do what.** `catalog.quick_create` lets sales staff type a new item when the shop allows it. `catalog.manage`, `catalog.merge` and `catalog.convert_to_managed` stay with the owner, an administrator, and (except merge) a manager. A cashier cannot import a list, merge, set a cost or start stock tracking.
- **Upgrade** links the remembered row to a product, moving its other names onto that product. Stock starts only from a quantity the owner types. Old sale lines keep their description, unit, quantity and price. `line_kind` on a sale line is `product`, `quick` or `service`, and is not rewritten later.
- **Profit.** The ledger profit figure is unchanged. The profit response also says whether cost is known, partial or unknown, how much of sales has a cost, and an estimated profit only when the owner has entered a cost for a period (`cost_estimates`). An estimate does not change the journals. Reports do not show a margin for a line with no cost.
- **Import.** A pasted list or a one-column CSV is previewed, then only the new names are added. Excel files are not read. There is no spreadsheet library in the app, and adding one is not justified for a list of names.
- **Offline.** The phone caches remembered items, product aliases and units. A new item sold offline is queued with the sale. Sync creates one item. Sending the same sale again does not create another.
- **Merge** is only for two remembered items that are not yet products. The dropped name becomes an alias. Sale descriptions are not rewritten. Merging two stocked products is refused.

## Consequences

- Search is prefix and contains, ranked in one shared function, not a trigram index.
- A typed name that exactly matches a product does not create a second item and does not move stock. The seller picks the product when stock should move.
- Historical lines imported with no product are marked `service`, so they are not treated as goods waiting for a cost.
- Usage counts (times sold, last price) are not written to the audit log. Creating, renaming, aliasing, upgrading, merging, archiving and estimating a cost are.
