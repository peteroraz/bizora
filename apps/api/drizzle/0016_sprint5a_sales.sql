-- Sprint 5a: quick sales. See docs/adr/ADR-015-quick-sales-and-imports.md.
-- Money is bigint kobo. Quantities are thousandths of the product's base unit.

CREATE TABLE IF NOT EXISTS sales (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  customer_id uuid,
  sale_number varchar(24),
  provisional_number varchar(24),
  external_ref varchar(64),
  status varchar(10) NOT NULL DEFAULT 'completed',
  history_only boolean NOT NULL DEFAULT false,
  source varchar(10) NOT NULL DEFAULT 'pos',
  currency_code char(3) NOT NULL,
  subtotal_minor bigint NOT NULL,
  discount_minor bigint NOT NULL DEFAULT 0,
  total_minor bigint NOT NULL,
  paid_minor bigint NOT NULL,
  balance_minor bigint NOT NULL,
  note varchar(240),
  receipt_token varchar(64) NOT NULL,
  journal_entry_id uuid,
  sold_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  membership_id uuid,
  device_id uuid,
  actor_type varchar(16) NOT NULL DEFAULT 'HUMAN',
  voided_at timestamptz,
  voided_by uuid,
  void_reason varchar(240),
  CONSTRAINT sales_status_ck CHECK (status IN ('completed', 'voided')),
  CONSTRAINT sales_source_ck CHECK (source IN ('pos', 'offline', 'import', 'capture')),
  CONSTRAINT sales_amounts_ck CHECK (
    subtotal_minor >= 0 AND discount_minor >= 0 AND discount_minor <= subtotal_minor
    AND total_minor = subtotal_minor - discount_minor
    AND paid_minor >= 0 AND balance_minor >= 0 AND paid_minor + balance_minor = total_minor
  ),
  CONSTRAINT sales_credit_customer_ck CHECK (balance_minor = 0 OR customer_id IS NOT NULL OR history_only),
  CONSTRAINT sales_number_ck CHECK (history_only OR sale_number IS NOT NULL),
  CONSTRAINT sales_business_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT sales_branch_fk FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  CONSTRAINT sales_customer_fk FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS sales_tenant_id_id_key ON sales (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS sales_tenant_business_id_key ON sales (tenant_id, business_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS sales_receipt_token_key ON sales (receipt_token);
CREATE UNIQUE INDEX IF NOT EXISTS sales_business_number_key ON sales (tenant_id, business_id, sale_number) WHERE sale_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS sales_branch_sold_idx ON sales (tenant_id, branch_id, sold_at);
CREATE INDEX IF NOT EXISTS sales_member_sold_idx ON sales (tenant_id, membership_id, sold_at);
CREATE INDEX IF NOT EXISTS sales_customer_idx ON sales (tenant_id, customer_id) WHERE customer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sale_lines (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  sale_id uuid NOT NULL,
  line_no smallint NOT NULL,
  product_id uuid,
  description varchar(160) NOT NULL,
  quantity bigint NOT NULL,
  entered_quantity bigint NOT NULL,
  entered_unit varchar(16) NOT NULL,
  unit_price_minor bigint NOT NULL,
  discount_minor bigint NOT NULL DEFAULT 0,
  line_total_minor bigint NOT NULL,
  cost_minor bigint,
  stock_movement_id uuid,
  CONSTRAINT sale_lines_quantity_ck CHECK (quantity > 0 AND entered_quantity > 0),
  CONSTRAINT sale_lines_amounts_ck CHECK (unit_price_minor >= 0 AND discount_minor >= 0 AND line_total_minor >= 0),
  CONSTRAINT sale_lines_sale_fk FOREIGN KEY (tenant_id, business_id, sale_id) REFERENCES sales (tenant_id, business_id, id),
  CONSTRAINT sale_lines_product_fk FOREIGN KEY (tenant_id, business_id, product_id) REFERENCES products (tenant_id, business_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS sale_lines_sale_line_key ON sale_lines (sale_id, line_no);
CREATE INDEX IF NOT EXISTS sale_lines_product_idx ON sale_lines (tenant_id, product_id);

CREATE TABLE IF NOT EXISTS sale_payments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  sale_id uuid NOT NULL,
  method varchar(10) NOT NULL,
  amount_minor bigint NOT NULL,
  reference varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sale_payments_method_ck CHECK (method IN ('cash', 'transfer', 'pos')),
  CONSTRAINT sale_payments_amount_ck CHECK (amount_minor > 0),
  CONSTRAINT sale_payments_sale_fk FOREIGN KEY (tenant_id, business_id, sale_id) REFERENCES sales (tenant_id, business_id, id)
);

CREATE INDEX IF NOT EXISTS sale_payments_sale_idx ON sale_payments (tenant_id, sale_id);
