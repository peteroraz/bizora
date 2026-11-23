# Quick catalog — implementation status

Record-first selling (ADR-049), on branch `cursor/quick-catalog-4c50`. What was found, what changed, and what is still limited.

## 1. Current behaviour found

ADR-041 already let a shop type an item on a sale, post it as sales income, skip stock, and remember the name on the server (`saved_items`) with a copy on the phone. Search was a local "contains". A new business sold from its product list only. Profit was one ledger number, so a missing cost looked like zero cost. See `docs/catalog/QUICK_CATALOG_GAP.md`.

## 2. Schema changes

Migration `apps/api/drizzle/0043_quick_catalog.sql`.

- New businesses default `sales_items` to `both`. Existing rows are not changed. `remember_items` and `quick_catalog` default on.
- `saved_items` gains `first_sold_at`, `source` (`typed`, `import`, `voice`, `migration`), `product_id`, `catalog_mode` (`quick` or `managed`) and `unit_set`. A unique key on `(tenant_id, business_id, name_key)` and a unique `(tenant_id, business_id, id)` for the product link.
- `item_aliases` — another name for a remembered item or a product, one or the other.
- `business_units` — a shop's own unit codes.
- `sale_lines.line_kind` — `product`, `quick` or `service`. Existing lines are filled from the product, then from a matching remembered name, otherwise service.
- `cost_estimates` — a cost for a period, on the item or the product, not on the sale.
- Permissions `catalog.quick_create`, `catalog.manage`, `catalog.merge`, `catalog.convert_to_managed`.

Existing remembered rows and typed sale lines are kept. The name key is not rewritten.

## 3. API changes

Remembered items, suggestions, name import, rename, aliases, upgrade, cost estimate, merge and archive are on `/api/v1/saved-items`. Units are on `/api/v1/units`. The sales day list can ask `GET /api/v1/sales/top-items`. A sale may send `itemSource: voice`. Profit adds `profitStatus`, `uncostedSalesMinor`, `costCoverageBps`, `knownProfitMinor` and `estimatedProfitMinor`. The existing `profitMinor` is the ledger figure and is unchanged.

Business export includes the three new tables. Creating a sample business still deletes every tenant table, so the new ones are removed with it.

## 4. UI changes

- Sale: "What did you sell?", suggestions with the last price and how often it sold, "Use … as a new item", each or for all of them, and market units. The field is still labelled "Find a product" so the current screens and tests keep working.
- Settings: remember typed items, and allow a name list.
- Home, for a shop that has not recorded a sale: record the first sale, or add a list of names.
- Onboarding's last step can go to the sale, the name list, or a new product. Finish setup still opens home.
- Stock links to the name list and to organise. Organise lists remembered items, saves a cost for the year, or starts stock tracking.
- The sales day shows what sold. Profit hides the number when cost is missing, and labels an estimate when one exists.

Copy is in `apps/web/messages/en.json`.

## 5. Search behaviour

Phone and server share `matchSaleItems`. Order: exact (including a barcode or SKU), prefix, alias, then a contains match once two characters are typed. Recently and frequently sold items rank higher, then a managed product. Nothing is selected on its own. An empty box shows recent and frequent tiles, not the whole catalog. There is no trigram index. A ranking of 10,000 names stays under 200 ms in the unit test.

## 6. Import behaviour

Paste or a text/CSV file. Preview, then add only new names. Duplicates, including a different case, are skipped. A cashier cannot import. Excel is not supported.

## 7. Offline behaviour

The saved-items cache now stores other names and units. A typed sale offline is queued as before. On sync, the name key and alias lookup create at most one item. The same operation id is a duplicate. The same sale id with a new operation id returns the sale that already exists, so the sale is not doubled.

## 8. Permissions

Sales and cashier receive `catalog.quick_create` only. Manage and convert are on the owner, administrator and manager. Merge is owner and administrator. A cost also needs `prices.cost.read`. Job-function grants in `packages/contracts/src/access.ts` match the migration.

## 9. Quick to managed

Upgrade creates a non-stock product, or a stocked one when the owner asks, or links a product that already has the same name key. Aliases move to the product. Historical lines stay `product_id` null with their original text. Merging two stocked products returns 409 `MANAGED_MERGE`.

## 10. Reporting changes

Top items group sale lines by description, unit and kind, and mark cost unknown when any goods line has no cost. They do not include a margin. Profit coverage is for the whole range, not each day. Service lines are not treated as goods waiting for a cost.

## 11. Tests

- `packages/contracts`: name matching, ranking, name-list parsing, unit price from a total, voice "two cups of ogbono", alias "igbogbono".
- `apps/api/src/quick-catalog.test.ts`: first sale, prefix suggestion, one row for Ogbono/ogbono, walk-in, cup, name import, offline retry, upgrade leaves old lines, permissions, top items, no fake profit, a later estimate does not change ledger profit.
- `apps/api/src/typed-items.test.ts`: the products-only gate still holds after the owner turns it on. New shops are no longer products-only, so the test sets that itself.
- End-to-end `typed-items.e2e.ts` turns products-only on before it expects typed selling to be hidden, then turns both back on. Playwright runs in GitHub CI.

## 12. Known limitations

- No Excel import.
- Stocked products are not merged.
- A typed name that exactly matches a product does not move stock. The seller picks the product to do that.
- Lines brought in as history with no product are `service`, so they are outside the cost-coverage figure.
- Profit coverage is for the range, not per day.
- The last price is a suggestion. It is not a price list.
- A short unit code such as `boxes` now passes the unit check. It is remembered, not converted.
- Import does not bring back an archived name. Selling it does.
- Server suggestions use a prefix/contains limit of 40 rows, then the shared ranking.

## 13. Recommended next improvements

- A merge screen next to Organise, for the owner, still refusing stocked products.
- A cost for a chosen month, not only the current year.
- Suggest "you have sold this many times" on home, without converting anything.
- Read Excel if a parser is added for the full product import, and reuse it here.
