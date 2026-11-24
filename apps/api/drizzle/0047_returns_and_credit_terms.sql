-- ADR-059: how long after a sale goods may come back, and a customer's standard credit terms.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS returns_within_days integer;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS returns_on_receipt boolean NOT NULL DEFAULT false;
ALTER TABLE businesses ADD CONSTRAINT businesses_returns_within_days_ck CHECK (returns_within_days IS NULL OR returns_within_days BETWEEN 1 AND 365);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS credit_terms_days integer;
ALTER TABLE customers ADD CONSTRAINT customers_credit_terms_days_ck CHECK (credit_terms_days IS NULL OR credit_terms_days BETWEEN 1 AND 365);
