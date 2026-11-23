# Quick catalog — what was already there

Written before the record-first work (ADR-049), from the code on `main` after the pilot inventory release.

## Already in place (ADR-041)

- A sale line can be typed, with no product. It posts to sales income, not service income, and it does not move stock.
- `saved_items` is one row per business per name, on the server. It stores the last unit, last price, times sold and last sold at.
- The phone keeps a copy and can sell from it with no network. Sync uses the sale id, so a retry does not create a second sale.
- Settings choose products only, typed items only, or both. A shop that is products-only refuses a typed line at the counter. An offline sale is still kept.
- Voice can sell an item that is not in the products, and nothing is saved until the seller confirms.

## Gaps this work closes

- Remembered items were not a first-class list: no other names, no source, no link to a product, no way to turn one into stock later.
- Search on the sale screen was a simple "contains" over the phone cache. The server had no suggestion route, and aliases were not searched.
- Names that differed only by case or a trailing full stop could be two rows. There was no unique key to stop a race.
- Units were a fixed list. Cup, mudu and the rest could not be stored as the unit.
- There was no name-only import. Product import expects prices and stock columns.
- Profit was a single ledger number. A sale with no cost still produced a profit figure that treated the missing cost as zero.
- A new business defaulted to products only, so the first sale asked for a product.
- Staff who could sell could not be told apart from staff who may organise the list.

## Left as they are

- The sale, the outbox and the ledger are the same paths. There is no second sales system.
- Excel import is not added. The app has no spreadsheet parser.
- Two stocked products are not merged automatically. That can move the wrong stock.
