-- ADR-062: serial numbers and IMEIs, one per physical unit, for products that keep them.
ALTER TABLE products ADD COLUMN IF NOT EXISTS tracks_serials boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS serial_numbers (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  product_id uuid NOT NULL,
  -- The shop the unit is in, or was sold from.
  branch_id uuid NOT NULL,
  -- Kept as entered, without spaces, in capitals.
  serial varchar(64) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'in_stock',
  sale_id uuid,
  sale_line_id uuid,
  customer_id uuid,
  received_movement_id uuid,
  received_at timestamptz,
  sold_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT serial_numbers_product_fk FOREIGN KEY (tenant_id, business_id, product_id) REFERENCES products (tenant_id, business_id, id),
  CONSTRAINT serial_numbers_branch_fk FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  CONSTRAINT serial_numbers_status_ck CHECK (status IN ('in_stock', 'sold', 'returned', 'damaged', 'transferred', 'reserved')),
  CONSTRAINT serial_numbers_serial_ck CHECK (length(serial) > 0)
);
-- One unit per serial for a product in a business: the same serial cannot be sold twice.
CREATE UNIQUE INDEX IF NOT EXISTS serial_numbers_key ON serial_numbers (tenant_id, business_id, product_id, serial);
CREATE INDEX IF NOT EXISTS serial_numbers_serial_idx ON serial_numbers (tenant_id, business_id, serial);
CREATE INDEX IF NOT EXISTS serial_numbers_sale_idx ON serial_numbers (tenant_id, sale_id) WHERE sale_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS serial_numbers_stock_idx ON serial_numbers (tenant_id, product_id, branch_id) WHERE status IN ('in_stock', 'returned');

-- What happened to each unit, oldest first. Never changed.
CREATE TABLE IF NOT EXISTS serial_number_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  serial_id uuid NOT NULL REFERENCES serial_numbers (id),
  event varchar(24) NOT NULL,
  branch_id uuid,
  sale_id uuid,
  movement_id uuid,
  note varchar(240),
  actor_user_id uuid,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS serial_number_events_serial_idx ON serial_number_events (tenant_id, serial_id, at);
