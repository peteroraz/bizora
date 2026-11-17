-- Sprint 6d: customers with a history are archived, not deleted (ADR-022).
-- Their sales, payments and statements keep pointing at them; lists and searches leave them out.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS archived_at timestamptz;
CREATE INDEX IF NOT EXISTS customers_active_idx ON customers (tenant_id, business_id) WHERE archived_at IS NULL;

-- Starter gets a small taste of photo and voice reading: 10 a day (owner's decision, 17 Nov 2026).
-- Business uses the server's daily limit (AI_DAILY_CAPTURE_LIMIT, 50 by default). Both plans now list AI as included.
UPDATE plans SET limits = jsonb_set(jsonb_set(limits, '{ai_daily_reads}', '10'::jsonb), '{features,ai}', 'true'::jsonb) WHERE code = 'starter';
UPDATE plans SET limits = jsonb_set(limits, '{features,ai}', 'true'::jsonb) WHERE code = 'business';
