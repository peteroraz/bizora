-- ADR-049: record first, organise later. A typed or imported name is a quick item (saved_items).
-- It is not stock until someone chooses to track it. New businesses may type items from the start.
ALTER TABLE businesses ALTER COLUMN sales_items SET DEFAULT 'both';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS remember_items boolean NOT NULL DEFAULT true;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS quick_catalog boolean NOT NULL DEFAULT true;

ALTER TABLE saved_items ADD COLUMN IF NOT EXISTS first_sold_at timestamptz;
ALTER TABLE saved_items ADD COLUMN IF NOT EXISTS source varchar(16) NOT NULL DEFAULT 'typed';
ALTER TABLE saved_items DROP CONSTRAINT IF EXISTS saved_items_source_ck;
ALTER TABLE saved_items ADD CONSTRAINT saved_items_source_ck CHECK (source IN ('typed', 'import', 'voice', 'migration'));
ALTER TABLE saved_items ADD COLUMN IF NOT EXISTS product_id uuid;
ALTER TABLE saved_items ADD COLUMN IF NOT EXISTS catalog_mode varchar(8) NOT NULL DEFAULT 'quick';
ALTER TABLE saved_items DROP CONSTRAINT IF EXISTS saved_items_mode_ck;
ALTER TABLE saved_items ADD CONSTRAINT saved_items_mode_ck CHECK (catalog_mode IN ('quick', 'managed'));
ALTER TABLE saved_items ADD COLUMN IF NOT EXISTS unit_set boolean NOT NULL DEFAULT true;
UPDATE saved_items SET first_sold_at = coalesce(last_sold_at, created_at) WHERE first_sold_at IS NULL AND times_sold > 0;
CREATE UNIQUE INDEX IF NOT EXISTS saved_items_tenant_business_id_key ON saved_items (tenant_id, business_id, id);
ALTER TABLE saved_items DROP CONSTRAINT IF EXISTS saved_items_product_fk;
ALTER TABLE saved_items ADD CONSTRAINT saved_items_product_fk FOREIGN KEY (tenant_id, business_id, product_id) REFERENCES products (tenant_id, business_id, id);

CREATE TABLE IF NOT EXISTS item_aliases (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  saved_item_id uuid,
  product_id uuid,
  alias varchar(160) NOT NULL,
  alias_key varchar(160) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  CONSTRAINT item_aliases_one_target_ck CHECK ((saved_item_id IS NOT NULL)::int + (product_id IS NOT NULL)::int = 1),
  CONSTRAINT item_aliases_business_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT item_aliases_saved_fk FOREIGN KEY (tenant_id, business_id, saved_item_id) REFERENCES saved_items (tenant_id, business_id, id),
  CONSTRAINT item_aliases_product_fk FOREIGN KEY (tenant_id, business_id, product_id) REFERENCES products (tenant_id, business_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS item_aliases_key ON item_aliases (tenant_id, business_id, alias_key);
CREATE INDEX IF NOT EXISTS item_aliases_saved_idx ON item_aliases (tenant_id, business_id, saved_item_id);
CREATE INDEX IF NOT EXISTS item_aliases_product_idx ON item_aliases (tenant_id, business_id, product_id);

CREATE TABLE IF NOT EXISTS business_units (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  code varchar(16) NOT NULL,
  display_name varchar(40) NOT NULL,
  plural_name varchar(40),
  standard boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  CONSTRAINT business_units_business_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT business_units_code_ck CHECK (code ~ '^[a-z][a-z0-9]{0,15}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS business_units_code_key ON business_units (tenant_id, business_id, code);

ALTER TABLE sale_lines ADD COLUMN IF NOT EXISTS line_kind varchar(16);
UPDATE sale_lines SET line_kind = 'product' WHERE product_id IS NOT NULL AND line_kind IS NULL;
UPDATE sale_lines AS sl SET line_kind = 'quick' FROM saved_items si WHERE sl.product_id IS NULL AND sl.line_kind IS NULL AND sl.tenant_id = si.tenant_id AND sl.business_id = si.business_id AND si.name_key = lower(btrim(regexp_replace(regexp_replace(sl.description, '\s+', ' ', 'g'), '[.,;:!?]+$', '')));
UPDATE sale_lines SET line_kind = 'service' WHERE line_kind IS NULL;
ALTER TABLE sale_lines ALTER COLUMN line_kind SET DEFAULT 'product';
ALTER TABLE sale_lines ALTER COLUMN line_kind SET NOT NULL;
ALTER TABLE sale_lines DROP CONSTRAINT IF EXISTS sale_lines_kind_ck;
ALTER TABLE sale_lines ADD CONSTRAINT sale_lines_kind_ck CHECK (line_kind IN ('product', 'quick', 'service'));

CREATE TABLE IF NOT EXISTS cost_estimates (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  saved_item_id uuid,
  product_id uuid,
  estimated_cost_minor bigint NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  reason varchar(240) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  CONSTRAINT cost_estimates_cost_ck CHECK (estimated_cost_minor >= 0),
  CONSTRAINT cost_estimates_period_ck CHECK (period_end >= period_start),
  CONSTRAINT cost_estimates_one_target_ck CHECK ((saved_item_id IS NOT NULL)::int + (product_id IS NOT NULL)::int = 1),
  CONSTRAINT cost_estimates_business_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT cost_estimates_saved_fk FOREIGN KEY (tenant_id, business_id, saved_item_id) REFERENCES saved_items (tenant_id, business_id, id),
  CONSTRAINT cost_estimates_product_fk FOREIGN KEY (tenant_id, business_id, product_id) REFERENCES products (tenant_id, business_id, id)
);
CREATE INDEX IF NOT EXISTS cost_estimates_saved_idx ON cost_estimates (tenant_id, business_id, saved_item_id);

INSERT INTO permissions (id, code, description) VALUES
  ('11111111-1111-4111-8111-111111111152'::uuid, 'catalog.quick_create', 'Type a new item while recording a sale'),
  ('11111111-1111-4111-8111-111111111153'::uuid, 'catalog.manage', 'Rename remembered items, add aliases and units, and import a name list'),
  ('11111111-1111-4111-8111-111111111154'::uuid, 'catalog.merge', 'Merge two remembered items that are the same thing'),
  ('11111111-1111-4111-8111-111111111155'::uuid, 'catalog.convert_to_managed', 'Start tracking stock and cost for a remembered item')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role, permission_id)
SELECT grants.role, permissions.id FROM (VALUES
  ('OWNER', 'catalog.quick_create'),
  ('ADMINISTRATOR', 'catalog.quick_create'),
  ('MANAGER', 'catalog.quick_create'),
  ('SALES', 'catalog.quick_create'),
  ('CASHIER', 'catalog.quick_create'),
  ('OWNER', 'catalog.manage'),
  ('ADMINISTRATOR', 'catalog.manage'),
  ('MANAGER', 'catalog.manage'),
  ('OWNER', 'catalog.merge'),
  ('ADMINISTRATOR', 'catalog.merge'),
  ('OWNER', 'catalog.convert_to_managed'),
  ('ADMINISTRATOR', 'catalog.convert_to_managed'),
  ('MANAGER', 'catalog.convert_to_managed')
) AS grants (role, code) JOIN permissions ON permissions.code = grants.code
WHERE NOT EXISTS (SELECT 1 FROM role_permissions existing WHERE existing.role = grants.role AND existing.permission_id = permissions.id);
