# Inventory and catalog: what exists, the gaps, and the migration path

Phase 1 of the inventory and catalog redesign brief. Read against `main` at `12f8ded` on 23 Nov 2026: schema, the 38 migrations, `apps/api/src/modules/inventory`, `suppliers`, `sales`, `jobs`, `sync`, `packages/contracts`, the stock screens, the offline catalog, and ADR-014, ADR-029, ADR-030, ADR-033, ADR-034, ADR-035 and ADR-041.

## 1. What exists today

Bizora already has a real inventory engine. It is the base to extend, not to replace.

| Area | What is built | Where |
| --- | --- | --- |
| **Product** | `products`: name, free-text `category`, `base_unit` (one of 21 unit codes), `price_minor`, `default_cost_minor`, `low_stock_level`, one `barcode`, `track_stock`, `archived_at`. One business owns it. | `schema.ts`, ADR-014 |
| **Units** | `product_units`: up to 5 packs per product, each with `base_quantity` (thousandths of the base unit, bigint) and its own `price_minor`. Quantities are bigint thousandths everywhere (`QUANTITY_DECIMALS = 3`); there is no floating point. `splitIntoPacks` shows "3 cartons, 4 pieces". | `stock-units.ts` |
| **Stock by location** | `stock_balances (tenant, branch, product)`: quantity and value per shop. No global quantity column. | ADR-014 |
| **Movements** | `stock_movements`, immutable (a database trigger refuses updates and deletes). Types: `opening`, `received`, `sold`, `returned`, `adjusted`, `counted`, `transfer_out`, `transfer_in`, `supplier_return`, `job_use`, `job_return`. Each carries entered quantity and unit, reason, note, supplier, document number, transfer and count IDs, journal entry ID, device and actor. | `stock.service.ts` |
| **One way in** | `StockService.applyMovement()` locks the balance row and values the movement at **weighted-average cost**. It posts the ledger entry (key `stock:<movement id>`), writes the movement and updates the balance, all in one transaction. Stock cannot go below zero by a live action, only by offline or imported sales, and then it is flagged (`negative_since`). | ADR-014 |
| **Ledger** | Stock in posts Stock against Owner's money, Cash, Bank or Supplier payable. Removals post Stock losses. Sales post cost of sales. Returns reverse them. Debits always equal credits; this is tested. | ADR-013, ADR-014, ADR-030 |
| **Approvals** | Business work rules (ADR-034) can make receive, adjust, transfer and supplier return wait for a manager (`stock_requests`, pending, then approved or rejected). Stock counts are pending until approved. | `stock-request.service.ts` |
| **Counts** | `stock_counts`: one product at a time, with system quantity, counted quantity, difference, counter, approver and note. Approving posts a `counted` movement. Counts can be made offline. | `stock.service.ts` |
| **Transfers** | `POST /stock/transfer` writes `transfer_out` and `transfer_in` **at the same moment**, at the source's average value. Closing a shop moves all its stock. | `stock.service.ts` |
| **Suppliers** | `suppliers`, and `supplier_entries` for what is owed and paid, linked to the receipt movement. A receipt names one supplier; there is no list of which suppliers sell which product. | ADR-029 |
| **Photos** | Up to 5 photos per product: real PNG or JPEG only, size and pixel limits, stored in Postgres, shrunk on the phone. | ADR-033 |
| **Non-stock items** | `track_stock = false` products, and **saved items** (typed items, names sold without a product, ADR-041). Jobs (ADR-035) are service work with lines. | ADR-035, ADR-041 |
| **Permissions** | `products.manage`, `prices.cost.read`, `stock.read`, `stock.receive`, `stock.count`, `stock.transfer`, `stock.adjust`, `reports.stock.read`. The role map already matches the brief's example (details below the table). | `access.ts`, ADR-011 |
| **Offline** | `stock.receive` and `stock.count` are sync operations with device IDs, and retries return the same result. The phone keeps a copy of the business's products and stock per shop (`products/sync`, 500 a page) for lookups and sales. | ADR-012 |
| **Search** | Name (`ILIKE '%…%'`), exact barcode, category; 25 per page. No trigram index. | `product.service.ts` |
| **Import** | Product CSV import with a preview, up to 2,000 rows (ADR-015). | `stock/import` |
| **Audit** | Product create and edit, with a change reason required for price or cost changes and kept in its history; archive; every movement; approvals. | `product.service.ts` |
| **Archiving** | Products are archived, never deleted. Sales lines, movements and ledger entries keep pointing at them. | ADR-014 |

**The role map, in detail:**
- **SALES** sees products, selling prices and stock, and makes sales. It cannot see cost, adjust stock or edit products.
- **INVENTORY (storekeeper)** receives, counts and transfers stock.
- **MANAGER** adjusts stock, sees cost and edits products.
- **OWNER** has everything.

## 2. Gaps, by section of the brief

Status: ✅ already met · 🟡 partly met · ❌ missing.

| § | Requirement | Today | Gap |
| --- | --- | --- | --- |
| 1, 22, 41 | Simple item: name, price, quantity, unit; everything else optional | 🟡 The add-product form shows category, unit, price, packs, track stock, low stock, barcode, cost and opening stock all at once | Default view of 4 fields plus a photo; the rest behind **More options** |
| 2 | Item types: physical, service, digital, non-stock | 🟡 `track_stock` and saved items only | An `item_type` on the catalog item; services with duration, staff and commission |
| 3 | Item and variants, each with its own SKU, barcode, price, stock, image and supplier | ❌ One product is one stock unit; no variants | Catalog item over variants, with a default variant hidden from simple users |
| 4 | Category hierarchy | ❌ Free text, 60 characters | `categories` with a parent, order and active flag; keep the old text until moved |
| 5 | Brand entity | ❌ | `brands`, unique per business by normalised name |
| 6 | SKU, barcode, GTIN, MPN, supplier code, internal reference | 🟡 Barcode only | Separate fields; uniqueness per business where it makes sense (SKU, barcode) |
| 7 | Units: base, purchase, selling, conversions, custom | 🟡 Base plus packs as exact integer ratios; fixed list of 21 codes; no purchase or selling flags; no custom units | Custom unit names, purchase and selling flags per pack, and a guard against loops (cannot occur today, because packs only point at the base unit) |
| 8 | Price lists by unit, currency, shop, customer group, date, minimum quantity | 🟡 One price per product and per pack | `price_lists` and `variant_prices`; a customer can be given a price list |
| 9 | Purchase, last purchase, average and landed cost | 🟡 Weighted average per shop; default cost | Last purchase cost per variant; landed cost charges on a receipt, spread over its lines |
| 10 | Stock by location: shops, warehouses, back store | 🟡 Per shop (branch) | Warehouses (and later back stores) as places stock can sit |
| 11 | Movement ledger with standard types | 🟡 11 types, immutable | Map the brief's names to the existing types; add `damage`, `loss` and `expired` as reasons, and reservations |
| 12 | On hand, available, reserved, incoming, damaged, expired, in transit | 🟡 On hand only | Reserved and in transit first (they come with transfers and reservations); incoming from purchase orders later |
| 13 | Transfers with a lifecycle; destination rises only when received | ❌ Instant out and in | `stock_transfers` and lines: requested, approved, dispatched, received, cancelled. Out at dispatch, in at receipt, in transit between. The simple flow is dispatch and receive in one step. |
| 14 | Reorder rules | 🟡 Low stock level per product (not per shop) | `reorder_rules` per variant and shop: minimum, reorder point, target, maximum, preferred supplier, lead time |
| 15 | Several suppliers per product | ❌ | `supplier_products`: supplier code, last cost, preferred, lead time, minimum order, purchase unit, currency |
| 16 | Batch, lot and expiry, optional | ❌ | `stock_batches` and batch-aware movements when switched on for the item |
| 17 | Serial numbers and IMEI, optional | ❌ | `serial_numbers` with states; a sale line holds the serials sold; a serial cannot be sold twice |
| 18 | Attributes | ❌ | Attribute definitions, options and variant values; used to make variants |
| 19 | Images: primary, extra, per variant | 🟡 5 per product, first is main | Variant image; resized copies (today one shrunk copy is made on the phone) |
| 20 | Online-shop fields | ❌ | Optional fields on the catalog item; not on the simple form |
| 21 | Tax per item | ❌ | Taxable flag, tax code, prices with or without tax; no tax maths until a country pack needs it |
| 23 | Advanced form in sections | ❌ | Sections: Basic, Identification, Variants, Pricing, Stock, Units, Suppliers, Control, Online |
| 24 | Simple or advanced inventory per business | ❌ (switches exist in #46 for other things) | `inventory_mode` setting and switches per capability (variants, batches, serials, price lists, warehouses) |
| 25 | Permissions: catalog, pricing, inventory, supplier, batch, serial | 🟡 The roles exist; the codes are coarser | New codes mapped from the old ones so no one loses or gains access on the day of the change |
| 26 | Count sessions with lines and a lifecycle | 🟡 One product per count | `stock_count_sessions` and lines: draft, counting, submitted, approved, posted, cancelled. Posting writes `counted` movements. |
| 27 | Offline | 🟡 Receive and count | Add adjust requests, product create and session count lines through the same outbox |
| 28 | Search by SKU, barcode, GTIN, brand, category, supplier code; scanning | 🟡 Name, barcode, category; no scanning | More match fields; trigram index on names; camera scanning (BarcodeDetector where the browser has it, typing otherwise) |
| 29 | CSV import and export | 🟡 Import exists; export only through the full business export (#46) | More columns (type, SKU, brand, category, cost, wholesale price, supplier, reorder point); a product CSV export |
| 30 | `/catalog`, `/inventory`, `/pricing` endpoints | 🟡 `/products`, `/stock` | New domain routes; the old ones kept as they are (the phone app and the offline outbox use them) |
| 31 | Ledger kept whole | ✅ | Each new action uses `applyMovement` and the existing postings: transfers post nothing (stock stays in Stock); landed cost goes to Stock |
| 32 | Exact money and quantities | ✅ bigint minor units and thousandths | Keep it; prices per unit stay bigint |
| 34 | Tenant safety | ✅ Composite keys `(tenant_id, business_id, id)` on products | Same pattern for every new table; add them to the isolation matrix (#44) |
| 35 | Audit | 🟡 Most product and stock actions | Transfers, count sessions, batches and serials |
| 36 | No hard deletes | ✅ | Keep it |
| 38 | Performance at 10,000 products and 50,000 variants | ❓ Not measured; the phone copies the whole catalog | Measure; trigram index; page the phone's copy, or cap it to recent and low-stock items for large catalogs |

## 3. The key decision: where variants go

Two ways to add variants.

**A. New `product_variants` table; stock, sale lines and movements point at variants.**
- 8 foreign keys move, along with about 23 code files: stock, sales, returns, jobs, counts, requests, suppliers, offline, voice and import.
- Every offline operation already queued on a phone carries `productId`.
- It is the biggest risk to money, stock and offline that this brief could take.

**B. Recommended: the existing `products` row *is* the variant. A new `catalog_items` row is the parent.**
- Each product gets a `catalog_item_id`. Every existing product becomes a catalog item with one variant (the "default variant" of the brief), made by the migration.
- **Nothing that holds a `productId` changes:** stock, balances, movements, sale lines, the ledger, offline and voice. A variant is sold, counted and valued exactly as a product is today.
- Shared things move up to the catalog item: brand, category, type, description, online fields, tax code, attributes.
- Things that differ per variant stay on `products`: name suffix, SKU, barcode, price, cost, stock, photos, packs.
- A simple user never sees the difference: one item, one hidden variant.

B meets the brief's own rules ("extend and normalise", "no parallel inventory system", "a default variant internally"), at a fraction of the risk. In the code and API, `products` is called a **variant** from here on. The table keeps its name so that no migration rewrites history.

## 4. Second decision: warehouses

**A. Recommended: a warehouse is a branch with `kind = 'warehouse'`.**
- Balances, movements, permissions per shop, transfers, the offline copy and reports all work at once.
- A warehouse is hidden from the counter: no sales from it unless allowed.

**B. Sub-locations inside a branch (back store, shelf).**
- A new key on balances and movements, and every reader changes.

Start with A; leave B for later.

## 5. Migration path (one pull request per phase, each against `main`, CI green each time)

| Phase | Contents | Migrations | Risk |
| --- | --- | --- | --- |
| 2 | Catalog items over existing products (backfill 1:1); categories with parents (backfilled from the distinct text values); brands; item type; SKU, GTIN, MPN and reference on variants; custom units and purchase or selling flags on packs; the **simple Add item** form with More options; `/catalog/items`, `/catalog/categories`, `/catalog/brands`; new permission codes mapped from the old | 0040+ | Low: new tables and nullable columns, with a backfill |
| 3 | Warehouses as branches; transfers with a lifecycle and an in-transit balance; count sessions with lines; removal reasons (damage, loss, expired); stock status (available, reserved, in transit) | | Medium: new movement paths through `applyMovement` |
| 4 | Price lists and variant prices (with customer price lists); supplier products (several, preferred); last purchase cost; landed cost on receipts | | Medium: price chosen at the sale; cost into the ledger |
| 5 | Attributes and variant generation; batches and expiry; serial numbers (sold once only); reorder rules | | Medium: batch-aware and serial-aware sale and receipt |
| 6 | Offline (create item, adjust request, count session lines); CSV import and export with the new columns; barcode scanning; trigram search; performance at 10,000 products and 50,000 variants; phone polish; `docs/INVENTORY_IMPLEMENTATION_STATUS.md` and the final report | | Low to medium |

Each phase adds ADRs as the brief lists them: catalog and variant model (phase 2), units (phase 2), inventory movements, transfers and counts (phase 3), price lists and costing (phase 4), batches and serials (phase 5). Each phase also adds cross-tenant tests for its new tables.
