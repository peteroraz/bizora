-- Sprint 6a: debtors and payments (ADR-019).

-- A payment a customer makes towards what they owe. Cancelled payments stay, marked voided.
CREATE TABLE IF NOT EXISTS customer_payments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  payment_number varchar(20) NOT NULL,
  method varchar(10) NOT NULL,
  amount_minor bigint NOT NULL,
  currency_code char(3) NOT NULL,
  reference varchar(80),
  note varchar(240),
  received_at timestamptz NOT NULL,
  status varchar(10) NOT NULL DEFAULT 'recorded',
  journal_entry_id uuid,
  receipt_token varchar(64) NOT NULL,
  voided_at timestamptz,
  voided_by uuid,
  void_reason varchar(240),
  created_by uuid NOT NULL,
  membership_id uuid,
  device_id uuid,
  actor_type varchar(20) NOT NULL DEFAULT 'HUMAN',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_payments_method_ck CHECK (method IN ('cash', 'transfer', 'pos')),
  CONSTRAINT customer_payments_amount_ck CHECK (amount_minor > 0),
  CONSTRAINT customer_payments_status_ck CHECK (status IN ('recorded', 'voided')),
  CONSTRAINT customer_payments_customer_fk FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  CONSTRAINT customer_payments_branch_fk FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS customer_payments_tenant_id_id_key ON customer_payments (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS customer_payments_number_key ON customer_payments (tenant_id, business_id, payment_number);
CREATE UNIQUE INDEX IF NOT EXISTS customer_payments_receipt_token_key ON customer_payments (receipt_token);
CREATE INDEX IF NOT EXISTS customer_payments_customer_idx ON customer_payments (tenant_id, customer_id, received_at DESC);

-- Which credit sales a payment paid off, and how much of each.
CREATE TABLE IF NOT EXISTS payment_allocations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  sale_id uuid NOT NULL,
  amount_minor bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_allocations_amount_ck CHECK (amount_minor > 0),
  CONSTRAINT payment_allocations_payment_fk FOREIGN KEY (tenant_id, payment_id) REFERENCES customer_payments (tenant_id, id),
  CONSTRAINT payment_allocations_sale_fk FOREIGN KEY (tenant_id, sale_id) REFERENCES sales (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS payment_allocations_sale_idx ON payment_allocations (tenant_id, sale_id);
CREATE INDEX IF NOT EXISTS payment_allocations_payment_idx ON payment_allocations (tenant_id, payment_id);

-- A customer's statement link for WhatsApp. Making a new link stops the old one working.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS statement_token varchar(64);
CREATE UNIQUE INDEX IF NOT EXISTS customers_statement_token_key ON customers (statement_token) WHERE statement_token IS NOT NULL;

-- Cashiers can add a customer (name and phone) at the counter, without seeing or editing the customer list.
INSERT INTO permissions (id, code, description) VALUES
  ('11111111-1111-4111-8111-111111111149'::uuid, 'customers.add', 'Add a new or walk-in customer while recording a sale')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role, permission_id)
SELECT grants.role, permissions.id FROM (VALUES
  ('OWNER', 'customers.add'),
  ('ADMINISTRATOR', 'customers.add'),
  ('MANAGER', 'customers.add'),
  ('SALES', 'customers.add'),
  ('CASHIER', 'customers.add')
) AS grants (role, code) JOIN permissions ON permissions.code = grants.code
WHERE NOT EXISTS (SELECT 1 FROM role_permissions existing WHERE existing.role = grants.role AND existing.permission_id = permissions.id);
