-- ADR-038: profit comes only from sales. POS cash-out: cash given from the drawer against a payment on the shop's
-- POS machine, with an optional fee (added on the POS or paid in cash).
ALTER TABLE money_movements DROP CONSTRAINT IF EXISTS money_movements_kind_ck;
ALTER TABLE money_movements ADD CONSTRAINT money_movements_kind_ck
  CHECK (kind IN ('owner_in', 'owner_out', 'to_bank', 'from_bank', 'other_in', 'pos_cashout'));
ALTER TABLE money_movements ADD COLUMN IF NOT EXISTS fee_minor bigint NOT NULL DEFAULT 0;
ALTER TABLE money_movements ADD COLUMN IF NOT EXISTS fee_paid_by varchar(8);
ALTER TABLE money_movements DROP CONSTRAINT IF EXISTS money_movements_fee_ck;
ALTER TABLE money_movements ADD CONSTRAINT money_movements_fee_ck CHECK (
  fee_minor >= 0
  AND fee_minor <= amount_minor
  AND (fee_paid_by IS NULL OR fee_paid_by IN ('pos', 'cash'))
  AND (kind = 'pos_cashout' OR (fee_minor = 0 AND fee_paid_by IS NULL))
);
