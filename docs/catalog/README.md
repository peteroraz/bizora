# Catalog

What a business sells, and how it is organised. Decisions: ADR-014 (products and stock), ADR-046 (items, variants, categories, brands, codes and units), ADR-049 (record a sale first, organise the list later — `QUICK_CATALOG.md`).

## The model

```
Catalog item  (Polo shirt: type, category, brand, description, tax code, online details)
 └─ Variant = product  (Polo shirt Black / Large: SKU, barcode, GTIN, price, cost, packs, stock, photos)
```

- **An item with no variants** is still one item with one product. The trader sees "the item", never the word variant.
- **Stock, sales, returns, jobs, counts and the books** all use the product, exactly as before ADR-046.
- **Item types:** `physical` (keeps stock), `service`, `digital` and `non_stock`. The last three never keep stock.
- **Categories** nest up to 6 levels and can be stopped from use. **Brands** are one per name.
- **Codes:** a SKU is unique per business among products in use. Barcodes may repeat. A GTIN is checked by its check digit.
- **Units:** a base unit and up to 5 packs, each an exact whole ratio to the base unit, marked as bought in, sold in, or both.

## API

| Route | Who |
| --- | --- |
| `GET /api/v1/catalog/items?q=&categoryId=&brandId=&type=&page=` | `stock.read` |
| `GET /api/v1/catalog/items/:id` | `stock.read` |
| `POST /api/v1/catalog/items` (an item and 1–100 variants) | `products.manage` |
| `PATCH /api/v1/catalog/items/:id` | `products.manage` |
| `POST /api/v1/catalog/items/:id/variants` | `products.manage` |
| `POST /api/v1/catalog/items/:id/archive` | `products.manage` |
| `GET/POST /api/v1/catalog/categories`, `PATCH /api/v1/catalog/categories/:id` | read `stock.read`, change `products.manage` |
| `GET/POST /api/v1/catalog/brands`, `PATCH /api/v1/catalog/brands/:id` | read `stock.read`, change `products.manage` |
| `/api/v1/products` (unchanged; accepts the new fields) | as before |

Cost fields show only with `prices.cost.read`. Every create takes an `idempotency-key`, and a client-made ID makes a retry return the same item.

## Screens

- **Stock › Add item:** name, unit, price, quantity, photo. Everything else is under More options.
- **Stock › Categories and brands.**
- **A product's page:** category path, brand, SKU, and the item's other variants.
