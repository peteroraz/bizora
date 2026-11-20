-- Sprint 7i (ADR-035): jobs for service businesses (job cards), lines without a product, deposits.

CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  job_number varchar(20) NOT NULL,
  title varchar(160),
  problem varchar(1000),
  summary varchar(600),
  status varchar(12) NOT NULL DEFAULT 'open',
  opened_on date NOT NULL,
  promised_on date,
  sale_id uuid,
  finished_at timestamptz,
  finished_by uuid,
  cancelled_at timestamptz,
  cancelled_by uuid,
  cancel_reason varchar(240),
  created_by uuid NOT NULL,
  membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jobs_status_ck CHECK (status IN ('open', 'done', 'cancelled')),
  CONSTRAINT jobs_done_ck CHECK ((status = 'done') = (sale_id IS NOT NULL)),
  CONSTRAINT jobs_business_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT jobs_branch_fk FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  CONSTRAINT jobs_customer_fk FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  CONSTRAINT jobs_sale_fk FOREIGN KEY (tenant_id, sale_id) REFERENCES sales (tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_tenant_id_id_key ON jobs (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_number_key ON jobs (tenant_id, business_id, job_number);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (tenant_id, business_id, status, opened_on);
CREATE INDEX IF NOT EXISTS jobs_customer_idx ON jobs (tenant_id, customer_id, opened_on);

CREATE TABLE IF NOT EXISTS job_lines (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  job_id uuid NOT NULL,
  line_no smallint NOT NULL,
  kind varchar(8) NOT NULL,
  description varchar(160) NOT NULL,
  product_id uuid,
  quantity bigint NOT NULL,
  entered_quantity bigint NOT NULL,
  entered_unit varchar(16) NOT NULL,
  unit_price_minor bigint NOT NULL DEFAULT 0,
  line_total_minor bigint NOT NULL DEFAULT 0,
  cost_minor bigint NOT NULL DEFAULT 0,
  paid_from varchar(8),
  supplier varchar(160),
  stock_movement_id uuid,
  received_movement_id uuid,
  journal_entry_id uuid,
  used_on date NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  removed_by uuid,
  remove_reason varchar(240),
  CONSTRAINT job_lines_kind_ck CHECK (kind IN ('work', 'part', 'bought', 'helper')),
  CONSTRAINT job_lines_amounts_ck CHECK (quantity > 0 AND unit_price_minor >= 0 AND line_total_minor >= 0 AND cost_minor >= 0),
  CONSTRAINT job_lines_helper_ck CHECK (kind <> 'helper' OR line_total_minor = 0),
  CONSTRAINT job_lines_paid_from_ck CHECK (paid_from IS NULL OR paid_from IN ('cash', 'bank', 'owed')),
  CONSTRAINT job_lines_job_fk FOREIGN KEY (tenant_id, job_id) REFERENCES jobs (tenant_id, id),
  CONSTRAINT job_lines_product_fk FOREIGN KEY (tenant_id, business_id, product_id) REFERENCES products (tenant_id, business_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS job_lines_line_key ON job_lines (job_id, line_no);

-- Money taken on a job before it is finished is a deposit (held in Customer advance payments, 2100).
ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS job_id uuid;
CREATE INDEX IF NOT EXISTS customer_payments_job_idx ON customer_payments (tenant_id, job_id) WHERE job_id IS NOT NULL;

-- Parts go to a job, and come back if the line is removed.
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_type_ck;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_type_ck
  CHECK (movement_type IN ('opening', 'received', 'sold', 'returned', 'adjusted', 'counted', 'transfer_out', 'transfer_in', 'supplier_return', 'job_use', 'job_return'));
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_direction_ck;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_direction_ck CHECK (
  (movement_type IN ('opening', 'received', 'returned', 'transfer_in', 'job_return') AND quantity > 0)
  OR (movement_type IN ('sold', 'transfer_out', 'supplier_return', 'job_use') AND quantity < 0)
  OR movement_type IN ('adjusted', 'counted')
);

-- A finished job becomes a sale with source 'job'.
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_source_ck;
ALTER TABLE sales ADD CONSTRAINT sales_source_ck CHECK (source IN ('pos', 'offline', 'import', 'capture', 'job'));

-- Service businesses see Jobs.
UPDATE businesses SET visible_modules = array_append(visible_modules, 'jobs')
  WHERE industry_code IN ('professional-services', 'healthcare-clinic') AND NOT ('jobs' = ANY (visible_modules));
