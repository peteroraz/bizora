-- Sprint 4: products and stock. See docs/adr/ADR-014-products-and-stock.md.
-- Quantities are whole thousandths of a product's base unit (2.5 kg = 2500). Money is bigint kobo.
-- PL/pgSQL bodies stay on one line because this runner splits statements on a semicolon at the end of a line.

CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  name varchar(160) NOT NULL,
  category varchar(60),
  base_unit varchar(16) NOT NULL,
  price_minor bigint,
  default_cost_minor bigint,
  low_stock_level bigint,
  barcode varchar(64),
  track_stock boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT products_price_ck CHECK (price_minor IS NULL OR price_minor >= 0),
  CONSTRAINT products_cost_ck CHECK (default_cost_minor IS NULL OR default_cost_minor >= 0),
  CONSTRAINT products_low_stock_ck CHECK (low_stock_level IS NULL OR low_stock_level >= 0),
  CONSTRAINT products_business_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS products_tenant_id_id_key ON products (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS products_tenant_business_id_key ON products (tenant_id, business_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS products_business_name_key ON products (tenant_id, business_id, lower(name)) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS products_business_barcode_key ON products (tenant_id, business_id, barcode) WHERE barcode IS NOT NULL AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS products_business_updated_idx ON products (tenant_id, business_id, updated_at, id);

-- Pack sizes: 1 carton = 24 pieces is stored as base_quantity 24000 (thousandths of a piece).
CREATE TABLE IF NOT EXISTS product_units (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  product_id uuid NOT NULL,
  unit_code varchar(16) NOT NULL,
  base_quantity bigint NOT NULL,
  price_minor bigint,
  CONSTRAINT product_units_quantity_ck CHECK (base_quantity > 0),
  CONSTRAINT product_units_price_ck CHECK (price_minor IS NULL OR price_minor >= 0),
  CONSTRAINT product_units_product_fk FOREIGN KEY (tenant_id, business_id, product_id) REFERENCES products (tenant_id, business_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS product_units_product_unit_key ON product_units (product_id, unit_code);

-- Every change to stock is a row. Rows are never edited or deleted; on-hand quantity is derived.
CREATE TABLE IF NOT EXISTS stock_movements (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  product_id uuid NOT NULL,
  movement_type varchar(16) NOT NULL,
  quantity bigint NOT NULL,
  value_minor bigint NOT NULL,
  entered_quantity bigint NOT NULL,
  entered_unit varchar(16) NOT NULL,
  reason varchar(32),
  note varchar(240),
  supplier varchar(160),
  paid_from varchar(8),
  document_number varchar(24),
  transfer_id uuid,
  count_id uuid,
  journal_entry_id uuid,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  membership_id uuid,
  device_id uuid,
  actor_type varchar(16) NOT NULL DEFAULT 'HUMAN',
  CONSTRAINT stock_movements_type_ck CHECK (movement_type IN ('opening', 'received', 'sold', 'returned', 'adjusted', 'counted', 'transfer_out', 'transfer_in')),
  CONSTRAINT stock_movements_quantity_ck CHECK (quantity <> 0),
  CONSTRAINT stock_movements_direction_ck CHECK (
    (movement_type IN ('opening', 'received', 'returned', 'transfer_in') AND quantity > 0)
    OR (movement_type IN ('sold', 'transfer_out') AND quantity < 0)
    OR movement_type IN ('adjusted', 'counted')
  ),
  CONSTRAINT stock_movements_paid_from_ck CHECK (paid_from IS NULL OR paid_from IN ('cash', 'bank', 'credit', 'none')),
  CONSTRAINT stock_movements_business_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT stock_movements_branch_fk FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  CONSTRAINT stock_movements_product_fk FOREIGN KEY (tenant_id, business_id, product_id) REFERENCES products (tenant_id, business_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS stock_movements_tenant_id_id_key ON stock_movements (tenant_id, id);
CREATE INDEX IF NOT EXISTS stock_movements_product_idx ON stock_movements (tenant_id, product_id, created_at);
CREATE INDEX IF NOT EXISTS stock_movements_branch_idx ON stock_movements (tenant_id, branch_id, created_at);
CREATE INDEX IF NOT EXISTS stock_movements_transfer_idx ON stock_movements (tenant_id, transfer_id) WHERE transfer_id IS NOT NULL;

CREATE OR REPLACE FUNCTION bizora_stock_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Stock movements cannot be changed or deleted. Record a correction instead.' USING ERRCODE = '55000'; END $$;

DROP TRIGGER IF EXISTS stock_movements_immutable ON stock_movements;

CREATE TRIGGER stock_movements_immutable BEFORE UPDATE OR DELETE ON stock_movements FOR EACH ROW EXECUTE FUNCTION bizora_stock_immutable();

-- On-hand quantity and cost value per product per shop, kept in step with stock_movements in the same transaction.
CREATE TABLE IF NOT EXISTS stock_balances (
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  product_id uuid NOT NULL,
  quantity bigint NOT NULL DEFAULT 0,
  value_minor bigint NOT NULL DEFAULT 0,
  negative_since timestamptz,
  last_movement_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, branch_id, product_id),
  CONSTRAINT stock_balances_branch_fk FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  CONSTRAINT stock_balances_product_fk FOREIGN KEY (tenant_id, business_id, product_id) REFERENCES products (tenant_id, business_id, id)
);

CREATE INDEX IF NOT EXISTS stock_balances_business_updated_idx ON stock_balances (tenant_id, business_id, updated_at);

-- A storekeeper's count waits for a manager; the difference is applied when approved.
CREATE TABLE IF NOT EXISTS stock_counts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  product_id uuid NOT NULL,
  counted_quantity bigint NOT NULL,
  system_quantity bigint NOT NULL,
  difference bigint NOT NULL,
  status varchar(10) NOT NULL DEFAULT 'pending',
  note varchar(240),
  counted_by uuid,
  counted_membership_id uuid,
  device_id uuid,
  counted_at timestamptz NOT NULL,
  decided_by uuid,
  decided_at timestamptz,
  movement_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_counts_status_ck CHECK (status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT stock_counts_counted_ck CHECK (counted_quantity >= 0),
  CONSTRAINT stock_counts_difference_ck CHECK (difference = counted_quantity - system_quantity),
  CONSTRAINT stock_counts_branch_fk FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  CONSTRAINT stock_counts_product_fk FOREIGN KEY (tenant_id, business_id, product_id) REFERENCES products (tenant_id, business_id, id)
);

CREATE INDEX IF NOT EXISTS stock_counts_branch_status_idx ON stock_counts (tenant_id, branch_id, status, counted_at);
