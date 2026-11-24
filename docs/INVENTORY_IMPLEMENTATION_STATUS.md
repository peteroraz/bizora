# Inventory and catalog: implementation status

The inventory and catalog brief (43 sections) against what is built, as of **24 Nov 2026**. Phase 1's gap analysis is `docs/inventory/GAP_ANALYSIS.md`. This document closes it.

**Statuses:**
- **IMPLEMENTED:** built, tested and documented.
- **PARTIAL:** the core is built; what is missing is named.
- **NOT IMPLEMENTED:** not built.
- **DEFERRED:** not built, on purpose, with the reason.

**Where it is:**
- **main:** merged.
- **PR #nn:** open, CI green, waiting to be merged.

Phases 5 and 6 are in open PRs (#64–#71, listed at the end).

## Capabilities, section by section

| § | Capability | Status | Where | Notes |
| --- | --- | --- | --- | --- |
| 1 | Extend the existing engine, no parallel inventory | IMPLEMENTED | main | `products` is the variant, under a new `catalog_items` parent (ADR-046). Everything that holds a product ID kept working. |
| 2 | Item types: physical, service, digital, non-stock | IMPLEMENTED | main | Only physical items keep stock. A service has a duration and a commission (ADR-046). |
| 3 | Item and variants, each with its own SKU, barcode, price, stock, photo and supplier | IMPLEMENTED | main | A simple item has one hidden variant (ADR-046). |
| 4 | Category hierarchy | IMPLEMENTED | main | Parents, order and active flag. Product files can name a path, "Drinks > Soft drinks" (PR #69). |
| 5 | Brands | IMPLEMENTED | main | Unique per business by normalised name. |
| 6 | SKU, barcode, GTIN, MPN, supplier code, internal reference | IMPLEMENTED | main | GTIN check digit is checked. Every code is searchable (PR #71 adds indexes for MPN and reference). |
| 7 | Units: base, purchase, selling, conversions, custom | IMPLEMENTED | main | Packs in exact thousandths, with purchase and sale flags. Custom units (ADR-049, ADR-053). |
| 8 | Price lists by unit, shop, customer, date and minimum quantity | IMPLEMENTED | main | ADR-048. A customer can be given a list. Product files can set a list price (PR #69). |
| 9 | Purchase, last purchase, average and landed cost | IMPLEMENTED | main | Weighted average per shop (ADR-014). Last and landed cost, with charges spread over a delivery (ADR-048). |
| 10 | Stock by location: shops and warehouses | IMPLEMENTED | main | A warehouse is a branch of kind warehouse (ADR-047). Warehouse cash is handled in PR #60. Shelf locations inside a shop are **DEFERRED**. |
| 11 | Movement ledger with standard types | PARTIAL | main | Immutable movements through one writer. Damage, loss and expiry are removal reasons. **Missing:** reservation movements. |
| 12 | Stock status: on hand, available, reserved, incoming, damaged, expired, in transit | PARTIAL | main | On hand and in transit (ADR-047). Expired by batch (PR #65). **Missing:** reserved, incoming (there are no purchase orders), and damaged as a separate quantity. |
| 13 | Transfers with a lifecycle | IMPLEMENTED | main | Requested, approved, dispatched, received and cancelled. Stock in transit in between (ADR-047). Batches travel with transfers (PR #65). |
| 14 | Reorder rules | IMPLEMENTED | PR #67 | Minimum, reorder point (the low stock level), target, maximum, usual supplier and lead time, for every shop or one. A "To buy" list per supplier. No forecasting, as the brief says (ADR-063). |
| 15 | Several suppliers per product | IMPLEMENTED | main | Supplier code, last cost, preferred, lead time, minimum order, purchase unit (ADR-048). |
| 16 | Batch, lot and expiry, optional | IMPLEMENTED | PR #65 | Switched on per product. First expiry first out. A counter sale is refused on expired stock; an offline sale is kept. Expiring list and notice (ADR-061). Batch costing is **DEFERRED**. |
| 17 | Serial numbers and IMEI, optional | IMPLEMENTED | PR #66 | One row per unit with states. Linked to sale and customer. Never sold twice. Found by serial (ADR-062). Naming serials on transfers is **DEFERRED**. |
| 18 | Attributes, and making variants from them | IMPLEMENTED | PR #64 | Text, number, list, multi-list and yes/no. Up to 100 variants a run, with a preview (ADR-060). |
| 19 | Images: main, extra, per variant | PARTIAL | main | Up to 5 per variant, the first is the main one (ADR-033). **Missing:** resized copies made on the server (the phone makes one shrunk copy). |
| 20 | Online-shop fields | PARTIAL | main | Slug, SEO title and description, condition, size and weight, visible online: stored and in the API (ADR-046). **Missing:** editing them on screen. |
| 21 | Tax per item | PARTIAL | main | Taxable flag, tax code, prices with or without tax: stored. **DEFERRED:** tax calculations, until a country pack needs them. |
| 22 | Simple product creation | IMPLEMENTED | main | Name, unit, price and quantity, with the rest under More options (ADR-046). Saved on the phone with no network (PR #68). |
| 23 | Advanced product form in sections | PARTIAL | main | Codes, packs, prices, suppliers, price lists, photos, attributes (PR #64), batches (PR #65), serials (PR #66) and reorder (PR #67) are on the product page. **Missing:** online and tax fields on screen. |
| 24 | Simple or advanced mode, capability switches | PARTIAL | main | Business switches (ADR-045). Batches and serials are switched on per product, off by default, and nothing shows until then. **Missing:** one business-wide inventory mode setting. |
| 25 | Permissions for catalog, pricing, inventory and suppliers | PARTIAL | main | `catalog.*`, `pricing.lists.manage`, `purchases.manage` and the stock codes, mapped so no one gained or lost access. **DEFERRED:** separate `batch.manage` and `serial.manage`. Batches and serials use stock in, removal and sale permissions. |
| 26 | Count sessions | IMPLEMENTED | main | Draft, counting, submitted, approved, posted, cancelled (ADR-047). Lines counted offline (PR #68). |
| 27 | Offline | IMPLEMENTED | PR #68 | Sales, stock in, counts, customers and payments were already offline. Added: new products, take off / add back (as a request where approval is needed), and count lines. A count is compared with the stock when it was made (ADR-064). |
| 28 | Search and scanning | IMPLEMENTED | PR #70, PR #71 | Name, category, brand and every code. Trigram indexes, falling back to ILIKE (ADR-067). Camera scanning with the browser's barcode reader, typing elsewhere (ADR-066). |
| 29 | Import and export | PARTIAL | PR #69 | SKU, GTIN, brand, category path, item and variant, pack yes/no, supplier code and price list, both ways (ADR-065). **Missing:** batch, expiry and serial columns, a small follow-up once #65 and #66 are merged. |
| 30 | `/catalog`, `/inventory` and `/pricing` routes | IMPLEMENTED | main | `/products` and `/stock` are kept for the phone and the outbox. |
| 31 | The books kept whole | IMPLEMENTED | main | Every stock change posts through `applyMovement`. Batches, serials, attributes and reorder rules post nothing. |
| 32 | Exact money and quantities | IMPLEMENTED | main | Bigint minor units and thousandths everywhere, including the new tables. |
| 33 | Versioned migrations | IMPLEMENTED | main + PRs | 0040–0046 on main; 0048–0052 in the PRs. |
| 34 | Tenant, business and shop safety | IMPLEMENTED | main + PRs | Composite keys on every new table. Each new `:id` route is in the isolation matrix. Each PR has a cross-business test. |
| 35 | Audit | IMPLEMENTED | main + PRs | Product, stock, transfer, count, price list, supplier, attribute, batch, serial, reorder and export actions. |
| 36 | Archive, never delete | IMPLEMENTED | main | Products, items, categories, brands and suppliers are archived. History keeps its links. |
| 37 | Testing | IMPLEMENTED | main + PRs | API integration tests on PGlite; e2e at 360 px on real Postgres; isolation matrix; performance budget. |
| 38 | Performance at 10,000 and 50,000 | IMPLEMENTED | PR #71 | Measured at 1,000, 10,000 and 50,000 products (`docs/PILOT_PERFORMANCE_BASELINE.md`). **Known limit:** a phone's first download at 50,000 products is 29 MB. |
| 39 | Documentation | IMPLEMENTED | main + PRs | ADR-046 to ADR-049 and ADR-060 to ADR-067, the gap analysis and this document. |
| 40 | Implementation order | IMPLEMENTED | | Phases 2 to 6 in the brief's order, one PR per part, each against main. |
| 41 | Small-business UX not overcomplicated | IMPLEMENTED | main + PRs | Every advanced capability is off or hidden until used. Stock screens checked at 360 px (this PR). |

## Final report (brief §42)

1. **Existing architecture found.** One product table with stock per shop, an immutable movement ledger with a single writer at weighted-average cost, ledger posting, approvals, single-product counts, instant transfers, offline stock in and counts. This is all in `docs/inventory/GAP_ANALYSIS.md`. It was extended, not replaced.
2. **Changes made.**
   - Catalog items over products, with categories, brands and codes (phase 2).
   - Warehouses, transfers with a lifecycle, count sessions (phase 3).
   - Price lists, supplier products, landed cost (phase 4).
   - Attributes, batches and expiry, serials, reorder rules (phase 5).
   - Offline product and stock work, product files both ways, camera scanning, trigram search with a measured 50,000-product catalog, and phone polish (phase 6).
3. **Migrations added.**
   - On main: 0040 catalog items; 0041 warehouses, transfers and counts; 0042 price lists, suppliers and landed cost; 0043 quick catalog; 0044 offline sales kept; 0045 compact names; 0046 old typed lines and units.
   - In PRs: 0048 attributes (#64); 0049 batches (#65); 0050 serials (#66); 0051 reorder rules (#67); 0052 trigram search (#71).
4. **Entities introduced or changed.**
   - New: `catalog_items`, `categories`, `brands`, `stock_transfers` and lines, `stock_count_sessions` and lines, `price_lists`, `price_list_prices`, `supplier_products`, `stock_receipts`, `attribute_definitions`, `attribute_options`, `variant_attribute_values`, `stock_batches`, `stock_movement_batches`, `serial_numbers`, `serial_number_events`, `reorder_rules`.
   - Changed: `products` gained `catalog_item_id`, SKU, GTIN, MPN, reference, last costs, `tracks_batches` and `tracks_serials`. `product_units` gained purchase and sale flags. `branches` gained a kind.
5. **API changes.**
   - Added:
     - `/catalog/items`, `/catalog/categories`, `/catalog/brands`, `/catalog/attributes`;
     - `/inventory/transfers`, `/inventory/counts`;
     - `/pricing/lists`, `/stock/receipts`;
     - `/products/:id/batches`, `/stock/expiring`;
     - `/products/:id/serials`, `/stock/serials`, `/sales/:id/serials`;
     - `/products/:id/reorder`, `/stock/to-buy`;
     - `/products/export.csv`.
   - Optional fields on stock in, sales, returns, removals and product files.
   - New sync types: `product.create`, `stock.adjust`, `stock.count_line`.
   - Nothing existing was removed or renamed.
6. **UI changes.**
   - Screens: Add item with More options; item and variant pages; categories and brands; transfers; count sessions; price lists; delivery with charges; attributes and Make variants; batches, Expiring stock, serials and Find a serial number; When to buy more and To buy; product file download.
   - The Scan button on the sale screen, counts, transfers and deliveries.
   - Offline saving of new products and count lines.
   - Phone layout of the stock screens.
7. **Permission changes.**
   - Added `catalog.quick_create`, `catalog.manage`, `catalog.merge`, `catalog.convert_to_managed`, `pricing.lists.manage` and `purchases.manage`. They are mapped from the old codes so every job keeps what it had.
   - Batches, serials and reorder rules use existing codes.
8. **Offline changes.** New products, take off / add back and count lines go through the outbox. Offline counts are compared with the stock at the time they were made, limited to a week back. Offline sales with expired batches or clashing serials are kept, and the owner is told.
9. **Accounting implications.**
   - Transfers post nothing: stock stays in Stock at the value that left.
   - Landed cost goes into stock value.
   - Batches, serials, attributes and reorder rules hold quantities and links only; stock value stays the weighted average.
   - Returns and cancellations restore serials without new postings.
10. **Tests added.** For every part: API integration tests (catalog, transfers and counts, pricing, attributes, batches, serials, reorder, offline work, product files), cross-business isolation, the `:id` isolation matrix, and e2e at 360 px. The phases 5–6 PRs add 6 API test files and 8 e2e files.
11. **Performance results.** At 50,000 products:
    - a specific search takes 64–81 ms and a common word 0.26 s, against 0.35–0.42 s before;
    - a sale takes 30 ms, a count line 12 ms, one product's page 13 ms;
    - a phone's first download is 29 MB in 3.4 s locally.

    Quick sale JavaScript is 159 kB of the 170 kB budget.
12. **Known limitations.**
    - No reservations, incoming stock or purchase orders.
    - No batch costing.
    - Serials are not named on transfers, and are not required at the counter.
    - No business-wide inventory mode.
    - Online and tax fields can be set through the API only.
    - Product files have one pack, one supplier and one price list price per row.
    - Scanning needs a browser with a barcode reader (not Safari on iPhone).
    - A phone's first download of a very large catalog is large.
13. **Backward compatibility.**
    - Every product became an item with one hidden variant.
    - Every route, sync type and offline queue item from before still works.
    - Old product files are read as before, except that a "sku" header now means SKU, not barcode.
    - New fields are optional and new switches are off.
    - Older phones' queued work syncs unchanged.
14. **Next recommended improvements.**
    - Batch and serial columns in product files.
    - Scan for IMEIs.
    - Naming serials on transfers.
    - Purchase orders, giving incoming stock.
    - Reservations for deposits.
    - A paged or filtered first download for very large catalogs.
    - Online and tax fields on screen.
    - Separate `batch.manage` and `serial.manage` if a pilot asks for them.

## Open PRs this status depends on

| PR | Part | ADR | Migration |
| --- | --- | --- | --- |
| #64 | Attributes and making variants | ADR-060 | 0048 |
| #65 | Batches and expiry | ADR-061 | 0049 |
| #66 | Serial numbers and IMEIs | ADR-062 | 0050 |
| #67 | Reorder rules and To buy | ADR-063 | 0051 |
| #68 | Offline products, stock changes and count lines | ADR-064 | none |
| #69 | Product files both ways | ADR-065 | none |
| #70 | Camera barcode scanning | ADR-066 | none |
| #71 | Trigram search and the 50,000-product check | ADR-067 | 0052 |
| this PR | Stock screens at 360 px, and this document | none | none |
