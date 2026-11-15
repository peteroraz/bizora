ALTER TABLE addresses
  ADD COLUMN IF NOT EXISTS market_or_plaza varchar(200),
  ADD COLUMN IF NOT EXISTS line_or_block varchar(80),
  ADD COLUMN IF NOT EXISTS shop_number varchar(40);

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS trader_profile jsonb;

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS business_type varchar(64),
  ADD COLUMN IF NOT EXISTS other_currencies boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS staff_count_band varchar(16),
  ADD COLUMN IF NOT EXISTS branch_count integer,
  ADD COLUMN IF NOT EXISTS what_you_sell text,
  ADD COLUMN IF NOT EXISTS multi_currency_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS staff_features_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS visible_modules text[] NOT NULL DEFAULT ARRAY['home','sales','stock','customers','debtors','money','staff','reports','settings'];

UPDATE businesses
SET business_type = CASE industry_code
  WHEN 'wholesale' THEN 'wholesale'
  WHEN 'hospitality' THEN 'food'
  WHEN 'professional-services' THEN 'services'
  WHEN 'healthcare-clinic' THEN 'services'
  ELSE 'shop'
END
WHERE business_type IS NULL AND industry_code IS NOT NULL;

UPDATE businesses AS business
SET branch_count = (
  SELECT COUNT(*)::int FROM branches AS branch
  WHERE branch.tenant_id = business.tenant_id AND branch.business_id = business.id
)
WHERE business.branch_count IS NULL;

CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid,
  name varchar(160) NOT NULL,
  phone_e164 varchar(20),
  is_walk_in boolean NOT NULL DEFAULT false,
  email varchar(320),
  address_id uuid,
  tags text[] NOT NULL DEFAULT '{}',
  notes_summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT customers_walk_in_phone_ck CHECK (
    (is_walk_in = true AND phone_e164 IS NULL) OR (is_walk_in = false AND phone_e164 IS NOT NULL)
  ),
  CONSTRAINT customers_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT customers_tenant_business_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT customers_tenant_branch_fk FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  CONSTRAINT customers_tenant_address_fk FOREIGN KEY (tenant_id, address_id) REFERENCES addresses (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS customers_tenant_business_idx ON customers (tenant_id, business_id);
CREATE INDEX IF NOT EXISTS customers_tenant_business_name_idx ON customers (tenant_id, business_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS customers_business_phone_key
  ON customers (tenant_id, business_id, phone_e164)
  WHERE phone_e164 IS NOT NULL;

CREATE TABLE IF NOT EXISTS customer_notes (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  CONSTRAINT customer_notes_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT customer_notes_customer_fk FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT customer_notes_business_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS customer_notes_customer_idx ON customer_notes (tenant_id, customer_id, created_at);

CREATE TABLE IF NOT EXISTS customer_followups (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  branch_id uuid,
  due_at timestamptz NOT NULL,
  reason varchar(500) NOT NULL,
  assigned_to uuid,
  status varchar(16) NOT NULL DEFAULT 'open',
  snoozed_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT customer_followups_status_ck CHECK (status IN ('open', 'done', 'snoozed')),
  CONSTRAINT customer_followups_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT customer_followups_customer_fk FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT customer_followups_business_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT customer_followups_branch_fk FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  CONSTRAINT customer_followups_assignee_fk FOREIGN KEY (tenant_id, assigned_to) REFERENCES memberships (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS customer_followups_due_idx ON customer_followups (tenant_id, business_id, status, due_at);

INSERT INTO permissions (id, code, description) VALUES
  ('11111111-1111-4111-8111-111111111113'::uuid, 'customers.read', 'Read customers and follow-ups'),
  ('11111111-1111-4111-8111-111111111114'::uuid, 'customers.manage', 'Create and change customers'),
  ('11111111-1111-4111-8111-111111111115'::uuid, 'followups.manage', 'Create and update follow-ups')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role, permission_id) VALUES
  ('OWNER', '11111111-1111-4111-8111-111111111113'::uuid),
  ('OWNER', '11111111-1111-4111-8111-111111111114'::uuid),
  ('OWNER', '11111111-1111-4111-8111-111111111115'::uuid),
  ('ADMINISTRATOR', '11111111-1111-4111-8111-111111111113'::uuid),
  ('ADMINISTRATOR', '11111111-1111-4111-8111-111111111114'::uuid),
  ('ADMINISTRATOR', '11111111-1111-4111-8111-111111111115'::uuid),
  ('MANAGER', '11111111-1111-4111-8111-111111111113'::uuid),
  ('MANAGER', '11111111-1111-4111-8111-111111111114'::uuid),
  ('MANAGER', '11111111-1111-4111-8111-111111111115'::uuid),
  ('SALES', '11111111-1111-4111-8111-111111111113'::uuid),
  ('SALES', '11111111-1111-4111-8111-111111111114'::uuid),
  ('SALES', '11111111-1111-4111-8111-111111111115'::uuid),
  ('CASHIER', '11111111-1111-4111-8111-111111111113'::uuid),
  ('ACCOUNTANT', '11111111-1111-4111-8111-111111111113'::uuid),
  ('AUDITOR', '11111111-1111-4111-8111-111111111113'::uuid)
ON CONFLICT DO NOTHING;
