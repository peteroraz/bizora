-- ADR-052: a compact name so a typed sale can find one product without reading the whole list.
-- Spaces and punctuation are ignored. The trigger keeps the column in step with bizora_compact_key, which matches compactItemKey.
CREATE OR REPLACE FUNCTION bizora_compact_key(raw text) RETURNS varchar(160) LANGUAGE sql IMMUTABLE AS $$ SELECT regexp_replace(left(lower(btrim(regexp_replace(regexp_replace(btrim(coalesce(raw, '')), '\s+', ' ', 'g'), '[.,;:!?]+$', ''))), 160), '[^a-z0-9]', '', 'g') $$;

ALTER TABLE products ADD COLUMN IF NOT EXISTS compact_key varchar(160);
UPDATE products SET compact_key = bizora_compact_key(name) WHERE compact_key IS NULL OR compact_key = '';
ALTER TABLE products ALTER COLUMN compact_key SET DEFAULT '';
ALTER TABLE products ALTER COLUMN compact_key SET NOT NULL;
CREATE INDEX IF NOT EXISTS products_compact_key_idx ON products (tenant_id, business_id, compact_key) WHERE archived_at IS NULL;

ALTER TABLE item_aliases ADD COLUMN IF NOT EXISTS compact_key varchar(160);
UPDATE item_aliases SET compact_key = bizora_compact_key(alias) WHERE compact_key IS NULL OR compact_key = '';
ALTER TABLE item_aliases ALTER COLUMN compact_key SET DEFAULT '';
ALTER TABLE item_aliases ALTER COLUMN compact_key SET NOT NULL;
CREATE INDEX IF NOT EXISTS item_aliases_compact_idx ON item_aliases (tenant_id, business_id, compact_key);

CREATE OR REPLACE FUNCTION bizora_set_compact_key() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_TABLE_NAME = 'products' THEN NEW.compact_key := bizora_compact_key(NEW.name); ELSE NEW.compact_key := bizora_compact_key(NEW.alias); END IF; RETURN NEW; END $$;
DROP TRIGGER IF EXISTS products_compact_key ON products;
CREATE TRIGGER products_compact_key BEFORE INSERT OR UPDATE OF name ON products FOR EACH ROW EXECUTE FUNCTION bizora_set_compact_key();
DROP TRIGGER IF EXISTS item_aliases_compact_key ON item_aliases;
CREATE TRIGGER item_aliases_compact_key BEFORE INSERT OR UPDATE OF alias ON item_aliases FOR EACH ROW EXECUTE FUNCTION bizora_set_compact_key();

-- A live sale can say which product a typed line looked like, without selling that product (ADR-052).
ALTER TABLE sale_lines ADD COLUMN IF NOT EXISTS possible_product_id uuid;
ALTER TABLE sale_lines DROP CONSTRAINT IF EXISTS sale_lines_possible_product_fk;
ALTER TABLE sale_lines ADD CONSTRAINT sale_lines_possible_product_fk FOREIGN KEY (tenant_id, business_id, possible_product_id) REFERENCES products (tenant_id, business_id, id);
