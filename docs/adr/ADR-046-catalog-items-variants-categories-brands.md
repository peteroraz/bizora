# ADR-046: Catalog items over products; variants, categories, brands, codes and units

## Status

Accepted on 23 Nov 2026. Phase 2 of the inventory and catalog redesign (`docs/inventory/GAP_ANALYSIS.md`). Builds on ADR-014 (products and stock).

## Context

The brief asks for items with variants, categories, brands, separate codes, item types and richer units. It also asks to keep the simple four-field flow for small traders.

Bizora already has a working stock engine (ADR-014). Stock, sale lines, returns, jobs, counts, requests, suppliers, the offline outbox and the voice catalog all point at `products.id`.

## Decision

### A product is a variant; a catalog item sits above it

Migration 0040 adds `catalog_items`. Each product gets `catalog_item_id`, which is NOT NULL and has a composite key to the item.

- **The item holds what variants share:**
  - type: physical, service, digital or non-stock;
  - name and description;
  - category and brand;
  - tax code and whether prices include tax;
  - service duration and commission;
  - optional online-shop details.
- **The product (the variant) keeps everything stock and money use:**
  - price, cost and packs;
  - stock and the low-stock level;
  - photos;
  - and new codes: `sku`, `gtin`, `mpn`, `reference`, plus `variant_label` ("Black / Large").
- **Existing products:** the migration gives each one an item with **the product's own ID**. Nothing that points at a product changes.
- **New products from older paths:** imports, photo reads, offline sync and older app versions do not name an item. A `BEFORE INSERT` trigger makes such a product its own item the same way. So the invariant "every product has an item" holds whatever path writes a product.
- **Names:** a variant's full name is the item's name plus its label (`variantName`). Receipts, stock lists and search keep reading `products.name`, unchanged. Renaming an item renames its variants.
- **The rejected option:** a separate `product_variants` table that stock and sales would point at instead. That would move 8 foreign keys and about 23 files, and every queued offline operation, which is the largest risk to money and stock the brief could take. It is recorded in the gap analysis.

### Categories

- `categories` has a parent, an order and an active flag, and an optional taxonomy code for online shops later.
- A name is unique per level, compared without case or extra spaces.
- **Depth:** at most 6 levels. Loops (a category under itself or its own child) are refused.
- **Filtering:** a list filtered by a category includes everything under it.
- **Stopping use:** a category no longer in use cannot be chosen, but its items stay in it.
- **Backfill:** the old free-text `products.category` became one top-level category per business and name. The text is kept in step for screens and phones that still read it: typing a name finds or makes the category, and renaming a category renames the text. The older edit form sends the name back unchanged, which is treated as no change, so a nested category is not flattened.

### Brands

- `brands` holds a name, manufacturer, website and logo address. Logo addresses must use https.
- A brand is unique per business by its normalised name: "Golden Penny", "golden penny" and "Golden  Penny" are the same brand.
- An item may have no brand.

### Codes

- **SKU:** the business's own code. Unique among its products in use, in any case (a partial unique index), and refused with `DUPLICATE_SKU` and the product that has it.
- **Barcode:** free text, so local and shop-made codes are fine. It may repeat (the same tin under two names) and is indexed for lookups.
- **GTIN:** must have a correct check digit.
- **MPN and reference:** free text.
- **Search:** products and items are found by name, barcode, GTIN, SKU, MPN, reference, brand and category.

### Item types

- Only **physical** items keep stock. A service or non-stock item gets no opening stock and no movements, even when a quantity is sent.
- A physical item with stock records cannot become a service (`ITEM_TYPE_LOCKED`), so its history stays consistent.

### Units

- **Quantities:** still whole thousandths of the base unit, in bigint (ADR-014). Packs are exact integer ratios to the base unit.
- **Loops:** every pack is defined against the base unit only, never against another pack, so a circular conversion cannot be expressed.
- **Buying and selling flags:** packs gain `for_purchase` and `for_sale`, both true by default. A live counter sale in a pack not sold that way is refused (`UNIT_NOT_FOR_SALE`), and so is a stock receipt in a pack not bought that way (`UNIT_NOT_FOR_PURCHASE`). Offline, imported and photo-read sales already happened, so they are not refused for this.
- **Unit list:** the 21 unit codes stay. Custom unit names are deferred, because every receipt, stock line and voice word reads the code.

### Permissions (no new codes yet)

The brief's permission names map onto the existing codes, so no one gains or loses access on the day of the change:

| Brief | Bizora |
| --- | --- |
| catalog.view, pricing.view_sell_price, inventory.view | `stock.read` |
| catalog.create, catalog.edit, catalog.archive, pricing.edit_sell_price | `products.manage` |
| pricing.view_cost, inventory.view_valuation | `prices.cost.read` |
| pricing.edit_cost | `products.manage` + `prices.cost.read` |
| inventory.receive, inventory.stock_count, inventory.transfer, inventory.adjust | `stock.receive`, `stock.count`, `stock.transfer`, `stock.adjust` |
| inventory.approve_adjustment | the stock approvers of ADR-034 (owners and managers) |
| supplier.view, supplier.manage | `purchases.manage` |

New codes are added only where nothing fits; price lists in phase 4 are the first.

### API

New routes under `/api/v1/catalog`, all with the tenant from the session and composite keys in the database:
- `categories`: GET, POST, PATCH;
- `brands`: GET, POST, PATCH;
- `items`: GET (search, category including sub-categories, brand, type, paging), GET by ID, POST (an item with 1 to 100 variants in one transaction), PATCH, `POST items/:id/variants` and `POST items/:id/archive`.

`/api/v1/products` keeps working and accepts the new fields.

### Screens

- **Add item:** item name, unit, selling price, how many you have, and an optional photo.
- **More options:** what it is, category, brand, cost, opening cost, low-stock warning, barcode, SKU and pack sizes. The categories and brands load only when the section opens.
- **Stock › Categories and brands:** nested categories (add, stop using) and brands.
- **The product page:** shows the category path, brand and SKU, and links between an item's variants.

## Consequences

- Every existing screen, sale, stock movement, ledger posting and offline operation works unchanged. They are tested by the full suite and the browser tests.
- A small trader still adds an item with four fields.
- **Tenant safety:**
  - each new table has `(tenant_id, business_id, id)` keys and composite foreign keys, so the database refuses an item in one business pointing at another's category, brand or item (tested);
  - after #44 merges, its isolation matrix must list the new routes.
- **Deferred:** custom unit names, variant photos (photos stay per product, so each variant has its own already), attributes and making variants from them (phase 5), price lists (phase 4), and editing an item's online and tax fields on screen (available through the API).
