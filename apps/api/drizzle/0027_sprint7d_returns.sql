-- Sprint 7d: returns from customers and to suppliers (ADR-030).

-- Goods a customer brought back from a sale, and how they were paid back.
CREATE TABLE IF NOT EXISTS sale_returns (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  sale_id uuid NOT NULL,
  customer_id uuid,
  return_number varchar(24) NOT NULL,
  total_minor bigint NOT NULL,
  -- Taken off what the customer still owed on the sale, then paid back in cash or by transfer.
  off_balance_minor bigint NOT NULL DEFAULT 0,
  refund_minor bigint NOT NULL DEFAULT 0,
  refund_method varchar(10),
  currency_code char(3) NOT NULL,
  reason varchar(240) NOT NULL,
  journal_entry_id uuid,
  created_by uuid NOT NULL,
  membership_id uuid,
  device_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sale_returns_total_ck CHECK (total_minor >= 0 AND total_minor = off_balance_minor + refund_minor),
  CONSTRAINT sale_returns_method_ck CHECK (refund_method IS NULL OR refund_method IN ('cash', 'transfer')),
  CONSTRAINT sale_returns_business_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT sale_returns_branch_fk FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS sale_returns_tenant_id_id_key ON sale_returns (tenant_id, id);
CREATE INDEX IF NOT EXISTS sale_returns_sale_idx ON sale_returns (tenant_id, sale_id);
CREATE INDEX IF NOT EXISTS sale_returns_day_idx ON sale_returns (tenant_id, business_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sale_return_lines (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  return_id uuid NOT NULL,
  sale_line_id uuid NOT NULL,
  quantity bigint NOT NULL,
  entered_quantity bigint NOT NULL,
  entered_unit varchar(16) NOT NULL,
  amount_minor bigint NOT NULL,
  cost_minor bigint NOT NULL DEFAULT 0,
  back_to_stock boolean NOT NULL,
  stock_movement_id uuid,
  CONSTRAINT sale_return_lines_quantity_ck CHECK (quantity > 0 AND entered_quantity > 0 AND amount_minor >= 0),
  CONSTRAINT sale_return_lines_return_fk FOREIGN KEY (tenant_id, return_id) REFERENCES sale_returns (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS sale_return_lines_line_idx ON sale_return_lines (tenant_id, sale_line_id);

-- Returns are records of what happened: never changed or deleted (a mistake is a new sale).
CREATE OR REPLACE FUNCTION bizora_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% rows cannot be changed or deleted.', TG_TABLE_NAME USING ERRCODE = '55000'; END $$;
DROP TRIGGER IF EXISTS sale_returns_append_only ON sale_returns;
CREATE TRIGGER sale_returns_append_only BEFORE UPDATE OR DELETE ON sale_returns FOR EACH ROW EXECUTE FUNCTION bizora_append_only();
DROP TRIGGER IF EXISTS sale_return_lines_append_only ON sale_return_lines;
CREATE TRIGGER sale_return_lines_append_only BEFORE UPDATE OR DELETE ON sale_return_lines FOR EACH ROW EXECUTE FUNCTION bizora_append_only();

-- What has come back from a sale so far, shown on the sale and kept off its total.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS returned_minor bigint NOT NULL DEFAULT 0;
-- The part of the returns taken off what the customer still owed. What was paid stays what was paid;
-- a cash refund is its own money movement.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS returned_off_balance_minor bigint NOT NULL DEFAULT 0;
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_amounts_ck;
ALTER TABLE sales ADD CONSTRAINT sales_amounts_ck CHECK (
  subtotal_minor >= 0 AND discount_minor >= 0 AND discount_minor <= subtotal_minor
  AND total_minor = subtotal_minor - discount_minor
  AND paid_minor >= 0 AND balance_minor >= 0
  AND returned_off_balance_minor >= 0 AND returned_off_balance_minor <= returned_minor AND returned_minor <= total_minor
  AND paid_minor + balance_minor + returned_off_balance_minor = total_minor
);

-- Goods sent back to a supplier leave stock as their own movement type.
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_type_ck;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_type_ck
  CHECK (movement_type IN ('opening', 'received', 'sold', 'returned', 'adjusted', 'counted', 'transfer_out', 'transfer_in', 'supplier_return'));
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_direction_ck;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_direction_ck CHECK (
  (movement_type IN ('opening', 'received', 'returned', 'transfer_in') AND quantity > 0)
  OR (movement_type IN ('sold', 'transfer_out', 'supplier_return') AND quantity < 0)
  OR movement_type IN ('adjusted', 'counted')
);

-- A supplier's account gains "return": goods sent back, taken off what is owed.
ALTER TABLE supplier_entries DROP CONSTRAINT IF EXISTS supplier_entries_kind_ck;
ALTER TABLE supplier_entries ADD CONSTRAINT supplier_entries_kind_ck CHECK (kind IN ('purchase', 'opening', 'payment', 'return'));
