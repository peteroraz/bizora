# ADR-065: Product files with the catalog's columns, both ways

## Status

Accepted on 24 Nov 2026. Inventory phase 6, item 2. Builds on ADR-015 (imports), ADR-046 (items and variants) and ADR-048 (packs, suppliers, price lists). No migration.

## Context

The product import read eleven columns: name, category, unit, price, cost, quantity, low stock, barcode, and one pack (unit, size, price). Since then, products have gained:
- SKU, GTIN and brand;
- category trees;
- variants under one item;
- packs that are only bought or only sold;
- supplier codes and price lists.

None of these could come from a file, and no product file could be downloaded.

## Decision

**New import columns,** all optional, so older files and older apps still work. Each column is matched by the header synonyms in `PRODUCT_IMPORT_COLUMNS`:
- SKU and GTIN, checked as on the product form. "sku" no longer means barcode.
- Brand, found by name or added.
- Category may be a path: "Drinks > Soft drinks", "Drinks / Soft drinks" or "Drinks › Soft drinks", at most three levels. Each level is found or added under the one above.
- **Item group** and **Variant**. A row with a variant is the product "Polo shirt Red / M" under the item "Polo shirt". The item group may be left empty, and then the name is the item. Variants of an item that is new are made as one item. A variant row for an item that already exists is added to it.
- **Pack sold** and **Pack bought** (yes / no) for the row's pack.
- **Supplier** and **Supplier code**: the supplier's own code for the product. The supplier is added when new. Only for people who manage buying.
- **Price list** and **Price list price**: the product's price on an existing price list, for one of the base unit. A list is never made from a file. Only for people who manage price lists.

The import is still checked in full first, and nothing is saved while any row has a problem. Every new column has its own message ("This GTIN is not right", "Write yes or no", "There is no price list called …").

**Download** (`GET /api/v1/products/export.csv`, `stock.read`) gives every product in use. It has the same columns, with headers the import recognises, so a file can be downloaded, changed in a spreadsheet and brought back in. Each row has:
- the product's first pack;
- its usual supplier (the preferred one, else the last to deliver);
- its first price list price for one of the base unit;
- this shop's stock.

Cost is in the file only for people who may see cost. Cells that start with `=`, `+`, `-` or `@` (and are not numbers) are written as text, so a spreadsheet does not run them. A 0 for stock or low stock reads back in. The download is audited (`products.exported`).

## Consequences

- One pack, one supplier and one price list price per row. A product with more keeps the others when its file row is brought back in, because the import only changes what the row names.
- Batch numbers with expiry dates, and serial numbers, are not columns yet. They come from PRs #65 and #66, which are not on main. Adding them to this file is a small follow-up once those are merged, using the same parser.

## Correction (24 Nov 2026): photos fill only the columns a photo shows

The first version asked the photo reader for every product file column. The new ones (codes, brand, item group, variant, pack sold, pack bought, supplier, supplier code, price list, price list price) had no explanation for the model, so on a supplier's invoice it guessed: quantities went into "Pack bought" and a number into "Pack unit", and every row was blocked. A product photo now asks only for name, category, unit, price, cost, quantity, reorder level, barcode and the pack (unit, size, price), as before. A test checks that every field asked of the model comes with an explanation. The products import screen also points a supplier's invoice to Record a delivery, because this screen does not add stock to products that already exist.
