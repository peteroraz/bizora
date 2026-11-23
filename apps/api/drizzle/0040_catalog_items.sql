-- ADR-046: catalog items over the existing products.
-- A product row stays what is stocked, sold, counted and valued (a variant, in the brief's words). A catalog item is
-- what the trader thinks of as "the item": its type, category, brand, description and online details. Every existing
-- product becomes an item with one variant, using the product's own ID for the item, so nothing that points at a
-- product changes.

-- Categories, nested. A category without a parent is a top category.
CREATE TABLE IF NOT EXISTS categories (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  parent_id uuid,
  name varchar(60) NOT NULL,
  name_key varchar(60) NOT NULL,
  position integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  -- Optional code in a shared product taxonomy (for online shops later). Never required.
  taxonomy_code varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT categories_business_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT categories_not_own_parent CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE UNIQUE INDEX IF NOT EXISTS categories_tenant_business_id_key ON categories (tenant_id, business_id, id);
-- One name per level: "Drinks" can sit under "Food" and under "Bar", but not twice under "Food".
CREATE UNIQUE INDEX IF NOT EXISTS categories_name_key ON categories (tenant_id, business_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), name_key);
ALTER TABLE categories ADD CONSTRAINT categories_parent_fk FOREIGN KEY (tenant_id, business_id, parent_id) REFERENCES categories (tenant_id, business_id, id);

CREATE TABLE IF NOT EXISTS brands (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  name varchar(80) NOT NULL,
  name_key varchar(80) NOT NULL,
  manufacturer varchar(120),
  website varchar(200),
  logo_url varchar(400),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT brands_business_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS brands_tenant_business_id_key ON brands (tenant_id, business_id, id);
-- "Golden Penny", "golden penny" and "Golden  Penny" are the same brand.
CREATE UNIQUE INDEX IF NOT EXISTS brands_name_key ON brands (tenant_id, business_id, name_key);

CREATE TABLE IF NOT EXISTS catalog_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  item_type varchar(16) NOT NULL DEFAULT 'physical',
  name varchar(160) NOT NULL,
  description varchar(2000),
  category_id uuid,
  brand_id uuid,
  -- Tax: a code from the country pack, and whether prices already include it. No tax is worked out yet.
  taxable boolean NOT NULL DEFAULT false,
  tax_code varchar(32),
  prices_include_tax boolean NOT NULL DEFAULT true,
  -- Services.
  duration_minutes integer,
  commission_basis_points integer,
  -- Online shop details, all optional.
  online_title varchar(160),
  short_description varchar(300),
  slug varchar(160),
  seo_title varchar(160),
  seo_description varchar(300),
  online_visible boolean NOT NULL DEFAULT false,
  item_condition varchar(16),
  weight_grams bigint,
  length_mm integer,
  width_mm integer,
  height_mm integer,
  taxonomy_code varchar(64),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT catalog_items_business_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT catalog_items_category_fk FOREIGN KEY (tenant_id, business_id, category_id) REFERENCES categories (tenant_id, business_id, id),
  CONSTRAINT catalog_items_brand_fk FOREIGN KEY (tenant_id, business_id, brand_id) REFERENCES brands (tenant_id, business_id, id),
  CONSTRAINT catalog_items_type_ck CHECK (item_type IN ('physical', 'service', 'digital', 'non_stock')),
  CONSTRAINT catalog_items_condition_ck CHECK (item_condition IS NULL OR item_condition IN ('new', 'used', 'refurbished')),
  CONSTRAINT catalog_items_numbers_ck CHECK ((duration_minutes IS NULL OR duration_minutes > 0) AND (commission_basis_points IS NULL OR commission_basis_points BETWEEN 0 AND 10000) AND (weight_grams IS NULL OR weight_grams >= 0))
);
CREATE UNIQUE INDEX IF NOT EXISTS catalog_items_tenant_business_id_key ON catalog_items (tenant_id, business_id, id);
CREATE INDEX IF NOT EXISTS catalog_items_category_idx ON catalog_items (tenant_id, business_id, category_id);
CREATE INDEX IF NOT EXISTS catalog_items_brand_idx ON catalog_items (tenant_id, business_id, brand_id);
CREATE UNIQUE INDEX IF NOT EXISTS catalog_items_slug_key ON catalog_items (tenant_id, business_id, slug) WHERE slug IS NOT NULL;

-- Each product is now a variant of an item, with its own codes.
ALTER TABLE products ADD COLUMN IF NOT EXISTS catalog_item_id uuid;
ALTER TABLE products ADD COLUMN IF NOT EXISTS variant_label varchar(80);
ALTER TABLE products ADD COLUMN IF NOT EXISTS sku varchar(64);
ALTER TABLE products ADD COLUMN IF NOT EXISTS gtin varchar(14);
ALTER TABLE products ADD COLUMN IF NOT EXISTS mpn varchar(64);
ALTER TABLE products ADD COLUMN IF NOT EXISTS reference varchar(64);

-- Which packs can be bought in and which sold in (a carton bought, pieces and packs sold).
ALTER TABLE product_units ADD COLUMN IF NOT EXISTS for_purchase boolean NOT NULL DEFAULT true;
ALTER TABLE product_units ADD COLUMN IF NOT EXISTS for_sale boolean NOT NULL DEFAULT true;

-- Categories from the free text already typed, one per business and name, at the top level.
INSERT INTO categories (id, tenant_id, business_id, name, name_key)
SELECT gen_random_uuid(), tenant_id, business_id, min(trim(category)), lower(regexp_replace(trim(category), '\s+', ' ', 'g'))
FROM products
WHERE category IS NOT NULL AND trim(category) <> ''
GROUP BY tenant_id, business_id, lower(regexp_replace(trim(category), '\s+', ' ', 'g'))
ON CONFLICT DO NOTHING;

-- One item per existing product, with the product's ID.
INSERT INTO catalog_items (id, tenant_id, business_id, item_type, name, category_id, created_at, updated_at, created_by, updated_by)
SELECT p.id, p.tenant_id, p.business_id, CASE WHEN p.track_stock THEN 'physical' ELSE 'non_stock' END, p.name, c.id, p.created_at, p.updated_at, p.created_by, p.updated_by
FROM products p
LEFT JOIN categories c ON c.tenant_id = p.tenant_id AND c.business_id = p.business_id AND c.parent_id IS NULL AND c.name_key = lower(regexp_replace(trim(p.category), '\s+', ' ', 'g'))
WHERE p.catalog_item_id IS NULL
ON CONFLICT (id) DO NOTHING;
UPDATE products SET catalog_item_id = id WHERE catalog_item_id IS NULL;

-- A product added by any path that does not name an item (imports, photo reads, offline sync, older app versions)
-- gets its own item, so every product always has one.
CREATE OR REPLACE FUNCTION bizora_product_item() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.catalog_item_id IS NULL THEN INSERT INTO catalog_items (id, tenant_id, business_id, item_type, name, category_id, created_by, updated_by) VALUES (NEW.id, NEW.tenant_id, NEW.business_id, CASE WHEN NEW.track_stock THEN 'physical' ELSE 'non_stock' END, NEW.name, (SELECT c.id FROM categories c WHERE c.tenant_id = NEW.tenant_id AND c.business_id = NEW.business_id AND c.parent_id IS NULL AND c.name_key = lower(regexp_replace(trim(coalesce(NEW.category, '')), '\s+', ' ', 'g')) LIMIT 1), NEW.created_by, NEW.updated_by) ON CONFLICT (id) DO NOTHING; NEW.catalog_item_id := NEW.id; END IF; RETURN NEW; END $$;
CREATE TRIGGER products_catalog_item BEFORE INSERT ON products FOR EACH ROW EXECUTE FUNCTION bizora_product_item();

ALTER TABLE products ALTER COLUMN catalog_item_id SET NOT NULL;
ALTER TABLE products ADD CONSTRAINT products_catalog_item_fk FOREIGN KEY (tenant_id, business_id, catalog_item_id) REFERENCES catalog_items (tenant_id, business_id, id);
CREATE INDEX IF NOT EXISTS products_catalog_item_idx ON products (tenant_id, catalog_item_id);

-- Codes: a SKU is the business's own code and is unique among its products in use; barcodes and GTINs may repeat
-- (the same tin under two names) but are looked up fast.
CREATE UNIQUE INDEX IF NOT EXISTS products_sku_key ON products (tenant_id, business_id, lower(sku)) WHERE sku IS NOT NULL AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS products_barcode_idx ON products (tenant_id, business_id, barcode) WHERE barcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS products_gtin_idx ON products (tenant_id, business_id, gtin) WHERE gtin IS NOT NULL;
