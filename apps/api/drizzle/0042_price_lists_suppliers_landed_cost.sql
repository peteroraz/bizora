-- ADR-048: price lists, several suppliers per product, last purchase cost and landed cost.

-- Price lists. A product's own price stays its everyday (retail) price; a list holds other prices, such as wholesale,
-- for a unit, from a minimum quantity, for a while, optionally only in one shop.
CREATE TABLE IF NOT EXISTS price_lists (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  name varchar(60) NOT NULL,
  name_key varchar(60) NOT NULL,
  currency_code char(3) NOT NULL,
  branch_id uuid,
  active boolean NOT NULL DEFAULT true,
  -- Staff without discount rights may pick this list at the counter (for example "Wholesale" in a wholesale shop).
  staff_can_choose boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT price_lists_business_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT price_lists_branch_fk FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS price_lists_tenant_business_id_key ON price_lists (tenant_id, business_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS price_lists_name_key ON price_lists (tenant_id, business_id, name_key);

CREATE TABLE IF NOT EXISTS price_list_prices (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  price_list_id uuid NOT NULL,
  product_id uuid NOT NULL,
  -- The product's base unit or one of its packs.
  unit_code varchar(16) NOT NULL,
  -- From how many (thousandths of that unit) the price applies: 1000 is "from 1".
  min_quantity bigint NOT NULL DEFAULT 1000,
  price_minor bigint NOT NULL,
  effective_from date,
  effective_to date,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT price_list_prices_list_fk FOREIGN KEY (tenant_id, business_id, price_list_id) REFERENCES price_lists (tenant_id, business_id, id),
  CONSTRAINT price_list_prices_product_fk FOREIGN KEY (tenant_id, business_id, product_id) REFERENCES products (tenant_id, business_id, id),
  CONSTRAINT price_list_prices_values_ck CHECK (min_quantity > 0 AND price_minor >= 0 AND (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from))
);
CREATE UNIQUE INDEX IF NOT EXISTS price_list_prices_key ON price_list_prices (price_list_id, product_id, unit_code, min_quantity, coalesce(effective_from, '1900-01-01'::date));
CREATE INDEX IF NOT EXISTS price_list_prices_product_idx ON price_list_prices (tenant_id, product_id);

-- A customer may buy at a list's prices (a wholesale buyer); a sale remembers the list it was priced from.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS price_list_id uuid;
ALTER TABLE customers ADD CONSTRAINT customers_price_list_fk FOREIGN KEY (tenant_id, business_id, price_list_id) REFERENCES price_lists (tenant_id, business_id, id);
ALTER TABLE sales ADD COLUMN IF NOT EXISTS price_list_id uuid;

-- Several suppliers per product, each with its own code, last cost and terms; one may be the preferred one.
CREATE TABLE IF NOT EXISTS supplier_products (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  product_id uuid NOT NULL,
  supplier_sku varchar(64),
  -- Per base unit of the product, in the currency below.
  last_cost_minor bigint,
  currency_code char(3) NOT NULL,
  preferred boolean NOT NULL DEFAULT false,
  lead_time_days integer,
  minimum_order_quantity bigint,
  purchase_unit varchar(16),
  last_received_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT supplier_products_supplier_fk FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id),
  CONSTRAINT supplier_products_product_fk FOREIGN KEY (tenant_id, business_id, product_id) REFERENCES products (tenant_id, business_id, id),
  CONSTRAINT supplier_products_values_ck CHECK ((last_cost_minor IS NULL OR last_cost_minor >= 0) AND (lead_time_days IS NULL OR lead_time_days BETWEEN 0 AND 365) AND (minimum_order_quantity IS NULL OR minimum_order_quantity > 0))
);
CREATE UNIQUE INDEX IF NOT EXISTS supplier_products_key ON supplier_products (tenant_id, supplier_id, product_id);
-- At most one preferred supplier per product.
CREATE UNIQUE INDEX IF NOT EXISTS supplier_products_preferred_key ON supplier_products (tenant_id, product_id) WHERE preferred;
CREATE INDEX IF NOT EXISTS supplier_products_code_idx ON supplier_products (tenant_id, business_id, lower(supplier_sku)) WHERE supplier_sku IS NOT NULL;

-- What the product last cost to buy, per base unit: the supplier's price, and with delivery and other charges.
ALTER TABLE products ADD COLUMN IF NOT EXISTS last_purchase_cost_minor bigint;
ALTER TABLE products ADD COLUMN IF NOT EXISTS last_landed_cost_minor bigint;
ALTER TABLE products ADD COLUMN IF NOT EXISTS last_purchased_at timestamptz;

-- A delivery of several products with charges (transport, clearing, loading, customs, freight) spread over them.
CREATE TABLE IF NOT EXISTS stock_receipts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  supplier_id uuid,
  document_number varchar(24),
  goods_minor bigint NOT NULL,
  charges_minor bigint NOT NULL DEFAULT 0,
  charges jsonb NOT NULL DEFAULT '[]'::jsonb,
  note varchar(240),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_receipts_business_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT stock_receipts_branch_fk FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS stock_receipts_tenant_business_id_key ON stock_receipts (tenant_id, business_id, id);

-- Each received movement says what part of its value is charges, and which delivery it came in.
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS charges_minor bigint NOT NULL DEFAULT 0;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS receipt_id uuid;

-- Managing price lists (owners, administrators and managers).
INSERT INTO permissions (id, code, description) VALUES
  ('11111111-1111-4111-8111-111111111151'::uuid, 'pricing.lists.manage', 'Make and change price lists, and give customers a price list')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role, permission_id)
SELECT grants.role, permissions.id FROM (VALUES
  ('OWNER', 'pricing.lists.manage'),
  ('ADMINISTRATOR', 'pricing.lists.manage'),
  ('MANAGER', 'pricing.lists.manage')
) AS grants (role, code) JOIN permissions ON permissions.code = grants.code
WHERE NOT EXISTS (SELECT 1 FROM role_permissions existing WHERE existing.role = grants.role AND existing.permission_id = permissions.id);
