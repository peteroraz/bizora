-- Sprint 7f (ADR-032): a default shop for each person, owners closing a shop (and moving it into another), and the
-- reason given when a stock count is approved or rejected.

-- The shop a person's Bizora opens in, when they may work in more than one shop.
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS default_branch_id uuid;
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_default_branch_fk;
ALTER TABLE memberships ADD CONSTRAINT memberships_default_branch_fk
  FOREIGN KEY (tenant_id, default_branch_id) REFERENCES branches (tenant_id, id);

-- A closed shop keeps its history; it can no longer be chosen, sold from or stocked.
ALTER TABLE branches ADD COLUMN IF NOT EXISTS closed_at timestamptz;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS closed_by uuid;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS closed_reason varchar(240);
ALTER TABLE branches ADD COLUMN IF NOT EXISTS moved_into_branch_id uuid;
ALTER TABLE branches DROP CONSTRAINT IF EXISTS branches_moved_into_fk;
ALTER TABLE branches ADD CONSTRAINT branches_moved_into_fk
  FOREIGN KEY (tenant_id, moved_into_branch_id) REFERENCES branches (tenant_id, id);
ALTER TABLE branches DROP CONSTRAINT IF EXISTS branches_closed_ck;
ALTER TABLE branches ADD CONSTRAINT branches_closed_ck CHECK (
  (closed_at IS NULL AND closed_reason IS NULL AND moved_into_branch_id IS NULL)
  OR (closed_at IS NOT NULL AND closed_reason IS NOT NULL AND (moved_into_branch_id IS NULL OR moved_into_branch_id <> id))
);

-- Why a count was approved or rejected, shown in the product's history.
ALTER TABLE stock_counts ADD COLUMN IF NOT EXISTS decision_note varchar(240);
