-- Amount-only sales (ADR-069): a sale line with an amount and no item.
-- Shops that already exist keep their screens as they are (off); new shops start with it on.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS amount_sales boolean NOT NULL DEFAULT false;
ALTER TABLE businesses ALTER COLUMN amount_sales SET DEFAULT true;

ALTER TABLE sale_lines DROP CONSTRAINT IF EXISTS sale_lines_kind_ck;
ALTER TABLE sale_lines ADD CONSTRAINT sale_lines_kind_ck CHECK (line_kind IN ('product', 'quick', 'service', 'amount'));

-- An amount line never names a product and never moves stock or carries a cost.
ALTER TABLE sale_lines DROP CONSTRAINT IF EXISTS sale_lines_amount_ck;
ALTER TABLE sale_lines ADD CONSTRAINT sale_lines_amount_ck CHECK (line_kind <> 'amount' OR (product_id IS NULL AND possible_product_id IS NULL AND stock_movement_id IS NULL AND cost_minor IS NULL));
