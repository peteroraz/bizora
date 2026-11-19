-- Sprint 7h (ADR-034): shop locks, opening hours, permission to work outside them, and stock changes that wait for
-- a manager or owner.

-- A locked shop takes no changes from staff until the owner unlocks it.
ALTER TABLE branches ADD COLUMN IF NOT EXISTS locked_at timestamptz;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS locked_by uuid;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS lock_note varchar(240);

-- Each weekday's opening and closing time in the business's time zone; null means no hours (open at any time).
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS opening_hours jsonb;

CREATE TABLE IF NOT EXISTS work_permits (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  note varchar(240),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid,
  CONSTRAINT work_permits_window_ck CHECK (ends_at > starts_at),
  CONSTRAINT work_permits_business_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT work_permits_membership_fk FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS work_permits_membership_idx ON work_permits (tenant_id, membership_id, ends_at);

CREATE TABLE IF NOT EXISTS stock_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  product_id uuid NOT NULL,
  kind varchar(16) NOT NULL,
  payload jsonb NOT NULL,
  summary varchar(400) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'pending',
  requested_by uuid NOT NULL,
  requested_membership_id uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_note varchar(240),
  result_movement_id uuid,
  CONSTRAINT stock_requests_kind_ck CHECK (kind IN ('receive', 'adjust', 'transfer', 'supplier_return')),
  CONSTRAINT stock_requests_status_ck CHECK (status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT stock_requests_decided_ck CHECK ((status = 'pending') = (decided_at IS NULL)),
  CONSTRAINT stock_requests_branch_fk FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  CONSTRAINT stock_requests_product_fk FOREIGN KEY (tenant_id, business_id, product_id) REFERENCES products (tenant_id, business_id, id)
);
CREATE INDEX IF NOT EXISTS stock_requests_status_idx ON stock_requests (tenant_id, business_id, status, requested_at);
