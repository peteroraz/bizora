-- ADR-061: batches (lots) and expiry dates, for products that track them.
ALTER TABLE products ADD COLUMN IF NOT EXISTS tracks_batches boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS stock_batches (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  product_id uuid NOT NULL,
  -- Both empty: stock with no batch (received before tracking began, or brought back by a customer).
  batch_number varchar(64),
  expiry_date date,
  manufactured_date date,
  supplier_id uuid,
  -- Thousandths of the base unit still here, and how much came in under this batch.
  quantity bigint NOT NULL DEFAULT 0,
  received_quantity bigint NOT NULL DEFAULT 0,
  first_received_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_batches_product_fk FOREIGN KEY (tenant_id, business_id, product_id) REFERENCES products (tenant_id, business_id, id),
  CONSTRAINT stock_batches_branch_fk FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  CONSTRAINT stock_batches_quantity_ck CHECK (quantity >= 0 AND received_quantity >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS stock_batches_tenant_business_id_key ON stock_batches (tenant_id, business_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS stock_batches_key ON stock_batches (tenant_id, branch_id, product_id, coalesce(batch_number, ''), coalesce(expiry_date, '1900-01-01'::date));
CREATE INDEX IF NOT EXISTS stock_batches_expiry_idx ON stock_batches (tenant_id, business_id, expiry_date) WHERE quantity > 0;

-- Which batches each movement took from or added to.
CREATE TABLE IF NOT EXISTS stock_movement_batches (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  movement_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  quantity bigint NOT NULL,
  CONSTRAINT stock_movement_batches_batch_fk FOREIGN KEY (tenant_id, business_id, batch_id) REFERENCES stock_batches (tenant_id, business_id, id)
);
CREATE INDEX IF NOT EXISTS stock_movement_batches_movement_idx ON stock_movement_batches (tenant_id, movement_id);
