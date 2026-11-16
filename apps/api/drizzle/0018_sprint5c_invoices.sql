-- Sprint 5c: invoices and receipts (ADR-017).
-- An invoice number (INV-000001) is given when the sales desk sends a sale to the cashier, and whenever a balance is
-- left on credit. The receipt number (R-000001) is given when the money is taken. Sales recorded before this
-- migration keep the numbers they have.

ALTER TABLE sales ADD COLUMN IF NOT EXISTS invoice_number varchar(20);
CREATE UNIQUE INDEX IF NOT EXISTS sales_invoice_number_key ON sales (tenant_id, business_id, invoice_number) WHERE invoice_number IS NOT NULL;
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_number_ck;
ALTER TABLE sales ADD CONSTRAINT sales_number_ck CHECK (history_only OR sale_number IS NOT NULL OR (collected_at IS NULL AND invoice_number IS NOT NULL));
