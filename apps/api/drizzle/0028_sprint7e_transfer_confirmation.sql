-- Sprint 7e: transfers wait for someone who can see the bank to confirm them (ADR-031).
-- A transfer recorded by staff who cannot see the bank is held in "Transfers waiting for confirmation" (1160)
-- until it is confirmed (by hand or by a bank statement line) or marked as never received.
-- Every payment recorded before this migration counts as confirmed.

ALTER TABLE sale_payments ADD COLUMN IF NOT EXISTS confirmation varchar(12) NOT NULL DEFAULT 'confirmed';
ALTER TABLE sale_payments ADD COLUMN IF NOT EXISTS confirmed_via varchar(16);
ALTER TABLE sale_payments ADD COLUMN IF NOT EXISTS confirmed_by uuid;
ALTER TABLE sale_payments ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;
ALTER TABLE sale_payments ADD COLUMN IF NOT EXISTS confirmation_entry_id uuid;
ALTER TABLE sale_payments ADD COLUMN IF NOT EXISTS not_received_as varchar(8);
ALTER TABLE sale_payments ADD COLUMN IF NOT EXISTS confirmation_note varchar(240);

ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS confirmation varchar(12) NOT NULL DEFAULT 'confirmed';
ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS confirmed_via varchar(16);
ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS confirmed_by uuid;
ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;
ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS confirmation_entry_id uuid;
ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS confirmation_note varchar(240);

ALTER TABLE sale_payments DROP CONSTRAINT IF EXISTS sale_payments_confirmation_ck;
ALTER TABLE sale_payments ADD CONSTRAINT sale_payments_confirmation_ck CHECK (
  confirmation IN ('confirmed', 'waiting', 'not_received')
  AND (confirmation = 'confirmed' OR method = 'transfer')
  AND (confirmed_via IS NULL OR confirmed_via IN ('by_hand', 'bank_statement'))
  AND (not_received_as IS NULL OR (confirmation = 'not_received' AND not_received_as IN ('owed', 'lost')))
  AND (confirmation <> 'not_received' OR not_received_as IS NOT NULL)
);

ALTER TABLE customer_payments DROP CONSTRAINT IF EXISTS customer_payments_confirmation_ck;
ALTER TABLE customer_payments ADD CONSTRAINT customer_payments_confirmation_ck CHECK (
  confirmation IN ('confirmed', 'waiting', 'not_received')
  AND (confirmation = 'confirmed' OR method = 'transfer')
  AND (confirmed_via IS NULL OR confirmed_via IN ('by_hand', 'bank_statement'))
);

CREATE INDEX IF NOT EXISTS sale_payments_waiting_idx ON sale_payments (tenant_id, business_id) WHERE confirmation = 'waiting';
CREATE INDEX IF NOT EXISTS customer_payments_waiting_idx ON customer_payments (tenant_id, business_id) WHERE confirmation = 'waiting';
