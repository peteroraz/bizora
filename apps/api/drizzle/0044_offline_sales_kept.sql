-- ADR-050: an offline sale is kept. If the server still cannot record it, the owner can.
CREATE TABLE IF NOT EXISTS sync_problems (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organizations (id),
  business_id uuid,
  branch_id uuid,
  membership_id uuid NOT NULL,
  device_id uuid,
  operation_id uuid NOT NULL,
  payload jsonb NOT NULL,
  error_code varchar(64) NOT NULL,
  error_message varchar(400) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid,
  resolution varchar(16),
  reason varchar(240),
  CONSTRAINT sync_problems_resolution_ck CHECK (resolution IS NULL OR resolution IN ('recorded', 'not_a_sale')),
  CONSTRAINT sync_problems_business_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT sync_problems_branch_fk FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  CONSTRAINT sync_problems_membership_fk FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships (tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS sync_problems_operation_key ON sync_problems (tenant_id, operation_id);
CREATE INDEX IF NOT EXISTS sync_problems_open_idx ON sync_problems (tenant_id, business_id, created_at) WHERE resolved_at IS NULL;
