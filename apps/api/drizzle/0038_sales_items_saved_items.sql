-- ADR-041: what a shop can sell. 'products' (only products from its list, stock checked), 'typed' (any item typed
-- in, remembered for next time, no stock) or 'both'. Existing shops keep selling from their list.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS sales_items varchar(10) NOT NULL DEFAULT 'products';
ALTER TABLE businesses DROP CONSTRAINT IF EXISTS businesses_sales_items_ck;
ALTER TABLE businesses ADD CONSTRAINT businesses_sales_items_ck CHECK (sales_items IN ('products', 'typed', 'both'));

-- Items typed in at a sale, remembered so they can be picked next time (names, unit and the last price only).
CREATE TABLE IF NOT EXISTS saved_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  name varchar(160) NOT NULL,
  name_key varchar(160) NOT NULL,
  unit varchar(16) NOT NULL DEFAULT 'piece',
  last_price_minor bigint,
  times_sold integer NOT NULL DEFAULT 0,
  last_sold_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT saved_items_tenant_business_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT saved_items_price_ck CHECK (last_price_minor IS NULL OR last_price_minor >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS saved_items_name_key ON saved_items (tenant_id, business_id, name_key);
CREATE INDEX IF NOT EXISTS saved_items_recent_idx ON saved_items (tenant_id, business_id, last_sold_at DESC);
