-- ADR-067: faster "contains" search on product, item, brand and customer names with trigram indexes.
-- Searches are still ILIKE, so they work the same where pg_trgm cannot be added (the database user may not be
-- allowed to add extensions, and tests run on PGlite): Postgres simply uses the indexes when they are there.
DO $$ BEGIN CREATE EXTENSION IF NOT EXISTS pg_trgm; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pg_trgm is not available: product search keeps working with ILIKE, without trigram indexes'; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN CREATE INDEX IF NOT EXISTS products_name_trgm_idx ON products USING gin (name gin_trgm_ops) WHERE archived_at IS NULL; CREATE INDEX IF NOT EXISTS products_category_trgm_idx ON products USING gin (category gin_trgm_ops) WHERE archived_at IS NULL AND category IS NOT NULL; CREATE INDEX IF NOT EXISTS catalog_items_name_trgm_idx ON catalog_items USING gin (name gin_trgm_ops) WHERE archived_at IS NULL; CREATE INDEX IF NOT EXISTS brands_name_trgm_idx ON brands USING gin (name gin_trgm_ops); CREATE INDEX IF NOT EXISTS customers_name_trgm_idx ON customers USING gin (name gin_trgm_ops); END IF; END $$;
-- MPN and reference are matched exactly, in any case, like the SKU; now each has its own index too.
CREATE INDEX IF NOT EXISTS products_mpn_lower_idx ON products (tenant_id, business_id, lower(mpn)) WHERE mpn IS NOT NULL;
CREATE INDEX IF NOT EXISTS products_reference_lower_idx ON products (tenant_id, business_id, lower(reference)) WHERE reference IS NOT NULL;
