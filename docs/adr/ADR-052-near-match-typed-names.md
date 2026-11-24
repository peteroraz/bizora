# ADR-052: A typed name finds the product without reading the whole list

## Status

Accepted on 24 Nov 2026. Builds on ADR-049 (a typed name that is a product). Migration `0045_compact_item_key.sql`.

## Context

Typing "Rice50kg" or "rice-50kg" did not find "Rice 50kg", so the sale was stored as a new item and stock did not move. Finding a typed name also read every product in the business.

A close spelling, such as "Ogbona" for "Ogbono", should not be sold as that product on its own. The seller may have meant a different thing.

## Decision

- `compactItemKey` drops spaces and punctuation after the existing name key. "Rice 50kg", "rice-50kg" and "Rice50kg" are one key. "Peak Milk 400g" and "Peak Milk 900g" stay different. "Ogb ono" is not the same saved name, but it is the same compact name.
- `products.compact_key` and `item_aliases.compact_key` store that key. A database trigger sets it on insert and when the name changes, using the same rule as `compactItemKey`. A sale looks up `compact_key IN (...)` for this business, and does not read the whole product list.
- One compact match is sold as that product, including another name and a remembered item already linked to it. Two products with the same compact name stay a typed line.
- If there is no compact match, a name of at least 6 characters is compared with products that start with the same 4 characters. One product within 2 edits is a suggestion, not a sale of that product. The line stays typed. A live sale returns `possibleProduct` with the product's id, name and price. Every source tells the owner (`sale.typed_like_product`). Two close products, or a shorter name, are left alone.
- On the sale screen, an exact compact match shows that product first and is chosen when the seller presses Enter. A close spelling is not chosen for them.

## Consequences

- Typing a name that is not a product still just works. Nothing in quick recording got harder.
- A second product that compacts to the same key is not guessed. The seller still picks one.
- The quick-sale script stays within 170 KB. The compact key is the same small helper the screen already loads for names, and the close-spelling count stays on the server.
