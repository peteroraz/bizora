-- Sprint 3C.5b: offline sync foundation and accounting core.
-- See docs/adr/ADR-012-offline-first-sync.md and docs/adr/ADR-013-accounting-core.md.
-- Note for this runner: statements are split on a semicolon at the end of a line, so every
-- PL/pgSQL function body below is written on one line.

-- 1. Idempotency keys: every offline-capable write carries a key; a retry returns the first result.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  tenant_id uuid NOT NULL REFERENCES organizations(id),
  key varchar(64) NOT NULL,
  scope varchar(120) NOT NULL,
  request_hash char(64) NOT NULL,
  membership_id uuid NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'in_progress',
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, key),
  CONSTRAINT idempotency_keys_status_ck CHECK (status IN ('in_progress', 'completed')),
  CONSTRAINT idempotency_keys_response_ck CHECK (status = 'in_progress' OR response_status IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idempotency_keys_created_idx ON idempotency_keys (created_at);

-- 2. Document numbers: devices issue provisional numbers, the server issues the official sequence.
CREATE TABLE IF NOT EXISTS document_sequences (
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  document_type varchar(32) NOT NULL,
  next_value bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, business_id, document_type),
  CONSTRAINT document_sequences_business_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT document_sequences_next_ck CHECK (next_value > 0)
);

ALTER TABLE shop_devices ADD COLUMN IF NOT EXISTS code integer;

UPDATE shop_devices SET code = numbered.n
FROM (SELECT id, row_number() OVER (PARTITION BY tenant_id ORDER BY created_at, id) AS n FROM shop_devices) AS numbered
WHERE shop_devices.id = numbered.id AND shop_devices.code IS NULL;

ALTER TABLE shop_devices ALTER COLUMN code SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS shop_devices_tenant_code_key ON shop_devices (tenant_id, code);

-- 3. Chart of accounts (one per business). Seeded from a template by the API, never by hand.
CREATE TABLE IF NOT EXISTS ledger_accounts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid,
  code varchar(20) NOT NULL,
  name varchar(120) NOT NULL,
  account_type varchar(16) NOT NULL,
  role varchar(32) NOT NULL,
  is_system boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT ledger_accounts_type_ck CHECK (account_type IN ('asset', 'liability', 'equity', 'income', 'expense')),
  CONSTRAINT ledger_accounts_cash_branch_ck CHECK (role <> 'cash' OR branch_id IS NOT NULL),
  CONSTRAINT ledger_accounts_business_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT ledger_accounts_branch_fk FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ledger_accounts_tenant_id_id_key ON ledger_accounts (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_accounts_tenant_business_id_key ON ledger_accounts (tenant_id, business_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_accounts_business_code_key ON ledger_accounts (tenant_id, business_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_accounts_branch_cash_key ON ledger_accounts (tenant_id, business_id, branch_id) WHERE role = 'cash';

-- 4. Monthly periods. A locked period takes no new entries; corrections go into an open period.
CREATE TABLE IF NOT EXISTS ledger_periods (
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  period_start date NOT NULL,
  status varchar(8) NOT NULL DEFAULT 'open',
  locked_at timestamptz,
  locked_by uuid,
  PRIMARY KEY (tenant_id, business_id, period_start),
  CONSTRAINT ledger_periods_status_ck CHECK (status IN ('open', 'locked')),
  CONSTRAINT ledger_periods_month_start_ck CHECK (extract(day FROM period_start) = 1),
  CONSTRAINT ledger_periods_business_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id)
);

-- 5. Journal entries and lines: immutable and balanced, enforced by the database.
CREATE TABLE IF NOT EXISTS journal_entries (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid,
  entry_date date NOT NULL,
  period_start date NOT NULL,
  currency_code char(3) NOT NULL,
  source_type varchar(32) NOT NULL,
  source_id uuid NOT NULL,
  posting_key varchar(160) NOT NULL,
  description varchar(240) NOT NULL,
  reverses_entry_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  CONSTRAINT journal_entries_period_ck CHECK (period_start = date_trunc('month', entry_date)::date),
  CONSTRAINT journal_entries_not_self_reversal_ck CHECK (reverses_entry_id IS NULL OR reverses_entry_id <> id),
  CONSTRAINT journal_entries_business_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT journal_entries_branch_fk FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  CONSTRAINT journal_entries_period_fk FOREIGN KEY (tenant_id, business_id, period_start) REFERENCES ledger_periods (tenant_id, business_id, period_start)
);

CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_tenant_id_id_key ON journal_entries (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_tenant_business_id_key ON journal_entries (tenant_id, business_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_posting_key ON journal_entries (tenant_id, posting_key);
CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_reversal_key ON journal_entries (tenant_id, reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS journal_entries_source_idx ON journal_entries (tenant_id, source_type, source_id);
CREATE INDEX IF NOT EXISTS journal_entries_business_date_idx ON journal_entries (tenant_id, business_id, entry_date);

ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS journal_entries_reverses_fk;

ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_reverses_fk FOREIGN KEY (tenant_id, business_id, reverses_entry_id) REFERENCES journal_entries (tenant_id, business_id, id);

CREATE TABLE IF NOT EXISTS journal_lines (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  account_id uuid NOT NULL,
  line_no smallint NOT NULL,
  debit_minor bigint NOT NULL DEFAULT 0,
  credit_minor bigint NOT NULL DEFAULT 0,
  original_currency_code char(3),
  original_amount_minor bigint,
  fx_rate numeric(24, 10),
  memo varchar(240),
  CONSTRAINT journal_lines_one_side_ck CHECK (debit_minor >= 0 AND credit_minor >= 0 AND (debit_minor = 0) <> (credit_minor = 0)),
  CONSTRAINT journal_lines_fx_ck CHECK (
    (original_currency_code IS NULL AND original_amount_minor IS NULL AND fx_rate IS NULL)
    OR (original_currency_code IS NOT NULL AND original_amount_minor > 0 AND fx_rate > 0)
  ),
  CONSTRAINT journal_lines_entry_fk FOREIGN KEY (tenant_id, business_id, entry_id) REFERENCES journal_entries (tenant_id, business_id, id),
  CONSTRAINT journal_lines_account_fk FOREIGN KEY (tenant_id, business_id, account_id) REFERENCES ledger_accounts (tenant_id, business_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS journal_lines_entry_line_key ON journal_lines (entry_id, line_no);
CREATE INDEX IF NOT EXISTS journal_lines_account_idx ON journal_lines (tenant_id, account_id);

-- Balanced: debits equal credits and there are at least two lines, checked when the transaction commits.
CREATE OR REPLACE FUNCTION bizora_assert_entry_balanced(target uuid) RETURNS void LANGUAGE plpgsql AS $$ DECLARE debits bigint; credits bigint; line_count integer; BEGIN SELECT coalesce(sum(debit_minor), 0), coalesce(sum(credit_minor), 0), count(*) INTO debits, credits, line_count FROM journal_lines WHERE entry_id = target; IF line_count < 2 OR debits <> credits THEN RAISE EXCEPTION 'Journal entry % is not balanced: debits %, credits %, lines %', target, debits, credits, line_count USING ERRCODE = '23514'; END IF; END $$;

CREATE OR REPLACE FUNCTION bizora_journal_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM bizora_assert_entry_balanced(NEW.id); RETURN NULL; END $$;

CREATE OR REPLACE FUNCTION bizora_journal_line_balanced() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM bizora_assert_entry_balanced(NEW.entry_id); RETURN NULL; END $$;

DROP TRIGGER IF EXISTS journal_entries_balanced ON journal_entries;

CREATE CONSTRAINT TRIGGER journal_entries_balanced AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bizora_journal_entry_balanced();

DROP TRIGGER IF EXISTS journal_lines_balanced ON journal_lines;

CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT ON journal_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bizora_journal_line_balanced();

-- Immutable: corrections are reversing entries, never edits or deletes.
CREATE OR REPLACE FUNCTION bizora_journal_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Journal entries cannot be changed or deleted. Post a reversing entry instead.' USING ERRCODE = '55000'; END $$;

DROP TRIGGER IF EXISTS journal_entries_immutable ON journal_entries;

CREATE TRIGGER journal_entries_immutable BEFORE UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION bizora_journal_immutable();

DROP TRIGGER IF EXISTS journal_lines_immutable ON journal_lines;

CREATE TRIGGER journal_lines_immutable BEFORE UPDATE OR DELETE ON journal_lines FOR EACH ROW EXECUTE FUNCTION bizora_journal_immutable();

-- Locked periods take no entries, and a locked period cannot be reopened.
CREATE OR REPLACE FUNCTION bizora_journal_period_open() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS (SELECT 1 FROM ledger_periods WHERE tenant_id = NEW.tenant_id AND business_id = NEW.business_id AND period_start = NEW.period_start AND status = 'locked') THEN RAISE EXCEPTION 'The period starting % is locked.', NEW.period_start USING ERRCODE = '55000'; END IF; RETURN NEW; END $$;

DROP TRIGGER IF EXISTS journal_entries_period_open ON journal_entries;

CREATE TRIGGER journal_entries_period_open BEFORE INSERT ON journal_entries FOR EACH ROW EXECUTE FUNCTION bizora_journal_period_open();

CREATE OR REPLACE FUNCTION bizora_ledger_period_no_reopen() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.status = 'locked' AND NEW.status <> 'locked' THEN RAISE EXCEPTION 'A locked period cannot be reopened.' USING ERRCODE = '55000'; END IF; RETURN NEW; END $$;

DROP TRIGGER IF EXISTS ledger_periods_no_reopen ON ledger_periods;

CREATE TRIGGER ledger_periods_no_reopen BEFORE UPDATE ON ledger_periods FOR EACH ROW EXECUTE FUNCTION bizora_ledger_period_no_reopen();
