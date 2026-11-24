# ADR-067: Trigram indexes for search, and checking a 50,000-product catalog

## Status

Accepted on 24 Nov 2026. Inventory phase 6, items 4 and 5. Migration `0052_trigram_search.sql`.

## Context

Product search matches anywhere in the name ("semov" finds Semovita) with `ILIKE '%…%'`, plus exact codes. B-tree indexes cannot help a match in the middle of a word, so Postgres reads every product of the business. That is fine at a few hundred products. Wholesalers and supermarkets bring 10,000 to 50,000, and the brief asks for the speed at those sizes to be measured.

## Decision

**Trigram indexes, with ILIKE kept.** The migration adds `pg_trgm` and GIN trigram indexes on:
- product names and categories (products in use only);
- item names;
- brand names;
- customer names.

The search is still `ILIKE`, so nothing depends on the extension:
- **Where `pg_trgm` cannot be added** (a database user without the right, or PGlite in tests), the migration says so in a notice and skips the indexes. Search works as before, more slowly on big catalogs.
- **Codes** (barcode, GTIN, SKU, supplier code) are matched exactly and have B-tree indexes. The migration adds the two that were missing, MPN and reference.

**The search query is split into a UNION.** It used to be one `OR` across the name, category, codes, brand and supplier code. A single `OR` with sub-queries makes Postgres read every product of the business, whatever the indexes. Now each kind of match is its own part of a `UNION`, so each part uses its own index. Each part also repeats "in use" (`archived_at IS NULL`), because the trigram and SKU indexes cover products in use only. What a search finds is unchanged; the existing search tests pass as they were.

**Statistics after a big import.** The first measurement found every search taking about 350 ms on a business that had just imported 1,000 products. A minute later, the same searches took 45 ms. Postgres had not yet looked at the new rows, so it planned with old statistics. An import of 200 products or more now runs `ANALYZE products` when it is saved (about 0.1 s at 50,000 products). Searches straight after the import then run at their normal speed.

**Measured at 1,000, 10,000 and 50,000 products** with `scripts/perf-catalog.ts`. The script fills one business through the product import and times the calls a shop makes against a big catalog:
- searches, the product list, one product's page;
- a sale, a count line, the sales summary and top items;
- the phone's full product download.

The numbers are in `docs/PILOT_PERFORMANCE_BASELINE.md`, under "Large catalogs".

## Consequences

- Cloud SQL allows `pg_trgm`. If the app's database user may not add extensions there, an administrator runs `CREATE EXTENSION pg_trgm` once and the migration is run again. The runbook says so.
- Each trigram index adds a little time to every product insert and name change. This shows in the import times measured.
- The phone's full product download grows with the catalog. At 50,000 products it is the slowest thing measured. Downloading only what changed (the cursors) keeps later syncs small. A first download of a very large catalog on a slow connection is a known limit for the pilot.
