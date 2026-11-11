ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS business_id uuid,
  ADD COLUMN IF NOT EXISTS branch_id uuid;
