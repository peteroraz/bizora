-- Sprint 7b: money in and out, cash per shop, profit (ADR-028).
-- Each row points at the ledger entry it posted; cancelling posts a reversing entry and keeps the row, marked voided.

-- What was paid for running the business: rent, transport, fuel. Staff record; the owner approves or rejects.
CREATE TABLE IF NOT EXISTS expenses (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  account_id uuid NOT NULL,
  amount_minor bigint NOT NULL,
  currency_code char(3) NOT NULL,
  paid_from varchar(10) NOT NULL,
  expense_date date NOT NULL,
  payee varchar(120),
  note varchar(240),
  status varchar(20) NOT NULL,
  journal_entry_id uuid,
  approved_at timestamptz,
  approved_by uuid,
  voided_at timestamptz,
  voided_by uuid,
  void_reason varchar(240),
  created_by uuid NOT NULL,
  membership_id uuid,
  device_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT expenses_amount_ck CHECK (amount_minor > 0),
  CONSTRAINT expenses_paid_from_ck CHECK (paid_from IN ('cash', 'bank', 'owner')),
  CONSTRAINT expenses_status_ck CHECK (status IN ('awaiting_approval', 'approved', 'voided')),
  CONSTRAINT expenses_business_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT expenses_branch_fk FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  CONSTRAINT expenses_account_fk FOREIGN KEY (tenant_id, business_id, account_id) REFERENCES ledger_accounts (tenant_id, business_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS expenses_tenant_id_id_key ON expenses (tenant_id, id);
CREATE INDEX IF NOT EXISTS expenses_day_idx ON expenses (tenant_id, business_id, expense_date DESC);
CREATE INDEX IF NOT EXISTS expenses_waiting_idx ON expenses (tenant_id, business_id) WHERE status = 'awaiting_approval';

-- The owner's money in and out, and cash moved between a drawer and the bank.
CREATE TABLE IF NOT EXISTS money_movements (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  kind varchar(16) NOT NULL,
  amount_minor bigint NOT NULL,
  currency_code char(3) NOT NULL,
  movement_date date NOT NULL,
  note varchar(240),
  status varchar(10) NOT NULL DEFAULT 'recorded',
  journal_entry_id uuid,
  voided_at timestamptz,
  voided_by uuid,
  void_reason varchar(240),
  created_by uuid NOT NULL,
  membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT money_movements_amount_ck CHECK (amount_minor > 0),
  CONSTRAINT money_movements_kind_ck CHECK (kind IN ('owner_in', 'owner_out', 'to_bank', 'from_bank', 'other_in')),
  CONSTRAINT money_movements_status_ck CHECK (status IN ('recorded', 'voided')),
  CONSTRAINT money_movements_business_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT money_movements_branch_fk FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS money_movements_tenant_id_id_key ON money_movements (tenant_id, id);
CREATE INDEX IF NOT EXISTS money_movements_day_idx ON money_movements (tenant_id, business_id, movement_date DESC);

-- A count of the cash in a shop's drawer. What was expected is worked out by the server at that moment; any
-- difference is posted to "Cash short or over", so the drawer's expected cash starts again from what was counted.
CREATE TABLE IF NOT EXISTS cash_counts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  count_date date NOT NULL,
  expected_minor bigint NOT NULL,
  counted_minor bigint NOT NULL,
  difference_minor bigint NOT NULL,
  currency_code char(3) NOT NULL,
  note varchar(240),
  journal_entry_id uuid,
  created_by uuid NOT NULL,
  membership_id uuid,
  device_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cash_counts_counted_ck CHECK (counted_minor >= 0),
  CONSTRAINT cash_counts_difference_ck CHECK (difference_minor = counted_minor - expected_minor),
  CONSTRAINT cash_counts_business_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT cash_counts_branch_fk FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS cash_counts_tenant_id_id_key ON cash_counts (tenant_id, id);
CREATE INDEX IF NOT EXISTS cash_counts_branch_idx ON cash_counts (tenant_id, branch_id, created_at DESC);

-- Reading a drawer's cash for a day goes through journal lines of one account, by entry date.
CREATE INDEX IF NOT EXISTS journal_entries_day_idx ON journal_entries (tenant_id, business_id, entry_date);
