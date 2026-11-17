-- Sprint 6b: bank statements and the reconciliation inbox (ADR-020).

CREATE TABLE IF NOT EXISTS statement_imports (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  account_label varchar(80) NOT NULL,
  source varchar(10) NOT NULL DEFAULT 'file',
  lines_new integer NOT NULL DEFAULT 0,
  lines_duplicate integer NOT NULL DEFAULT 0,
  lines_out_skipped integer NOT NULL DEFAULT 0,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT statement_imports_source_ck CHECK (source IN ('file', 'capture'))
);
CREATE UNIQUE INDEX IF NOT EXISTS statement_imports_tenant_id_id_key ON statement_imports (tenant_id, id);

-- Rules the owner saved: lines whose description contains the pattern are handled the same way next time.
CREATE TABLE IF NOT EXISTS statement_rules (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  pattern varchar(80) NOT NULL,
  target jsonb NOT NULL,
  times_used integer NOT NULL DEFAULT 0,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT statement_rules_pattern_ck CHECK (length(pattern) >= 3)
);
CREATE UNIQUE INDEX IF NOT EXISTS statement_rules_tenant_id_id_key ON statement_rules (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS statement_rules_pattern_key ON statement_rules (tenant_id, business_id, pattern);

-- One line of money in from a bank statement. The fingerprint stops the same line being imported twice.
CREATE TABLE IF NOT EXISTS statement_lines (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  import_id uuid NOT NULL,
  account_label varchar(80) NOT NULL,
  txn_date date NOT NULL,
  description varchar(300) NOT NULL DEFAULT '',
  reference varchar(120),
  amount_minor bigint NOT NULL,
  currency_code char(3) NOT NULL,
  fingerprint varchar(64) NOT NULL,
  status varchar(10) NOT NULL DEFAULT 'open',
  match_kind varchar(20),
  match_detail varchar(40),
  sale_payment_id uuid,
  customer_payment_id uuid,
  created_payment boolean NOT NULL DEFAULT false,
  customer_id uuid,
  journal_entry_id uuid,
  rule_id uuid,
  auto_matched boolean NOT NULL DEFAULT false,
  note varchar(200),
  matched_by uuid,
  matched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT statement_lines_amount_ck CHECK (amount_minor > 0),
  CONSTRAINT statement_lines_status_ck CHECK (status IN ('open', 'matched', 'ignored')),
  CONSTRAINT statement_lines_kind_ck CHECK (match_kind IS NULL OR match_kind IN ('recorded_payment', 'debtor', 'advance', 'money_in', 'own_transfer', 'ignored')),
  CONSTRAINT statement_lines_open_ck CHECK (status <> 'open' OR (match_kind IS NULL AND journal_entry_id IS NULL AND sale_payment_id IS NULL AND customer_payment_id IS NULL)),
  CONSTRAINT statement_lines_import_fk FOREIGN KEY (tenant_id, import_id) REFERENCES statement_imports (tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS statement_lines_fingerprint_key ON statement_lines (tenant_id, business_id, fingerprint);
-- A recorded payment can be confirmed by one statement line only: the same money is never counted twice.
CREATE UNIQUE INDEX IF NOT EXISTS statement_lines_sale_payment_key ON statement_lines (tenant_id, sale_payment_id) WHERE sale_payment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS statement_lines_customer_payment_key ON statement_lines (tenant_id, customer_payment_id) WHERE customer_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS statement_lines_inbox_idx ON statement_lines (tenant_id, business_id, status, txn_date);

INSERT INTO permissions (id, code, description) VALUES
  ('11111111-1111-4111-8111-111111111150'::uuid, 'bank.reconcile', 'Upload bank statements and match or classify their lines')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role, permission_id)
SELECT grants.role, permissions.id FROM (VALUES
  ('OWNER', 'bank.reconcile'),
  ('ADMINISTRATOR', 'bank.reconcile'),
  ('ACCOUNTANT', 'bank.reconcile')
) AS grants (role, code) JOIN permissions ON permissions.code = grants.code
WHERE NOT EXISTS (SELECT 1 FROM role_permissions existing WHERE existing.role = grants.role AND existing.permission_id = permissions.id);
