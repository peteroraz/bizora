ALTER TABLE businesses
  ADD CONSTRAINT businesses_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE branches
  ADD CONSTRAINT branches_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE branches
  ADD CONSTRAINT branches_tenant_business_fk
  FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id);

ALTER TABLE memberships
  ADD CONSTRAINT memberships_tenant_business_fk
  FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id);

ALTER TABLE memberships
  ADD CONSTRAINT memberships_tenant_branch_fk
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id);

ALTER TABLE memberships
  ADD CONSTRAINT memberships_scope_ck CHECK (branch_id IS NULL OR business_id IS NOT NULL);

ALTER TABLE invitations
  ADD CONSTRAINT invitations_tenant_business_fk
  FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id);

ALTER TABLE invitations
  ADD CONSTRAINT invitations_tenant_branch_fk
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id);

ALTER TABLE invitations
  ADD CONSTRAINT invitations_scope_ck CHECK (branch_id IS NULL OR business_id IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS invitations_pending_email_idx
  ON invitations (tenant_id, email)
  WHERE status = 'PENDING';

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  tenant_id uuid REFERENCES organizations(id),
  membership_id uuid,
  refresh_token_hash varchar(64) NOT NULL UNIQUE,
  family_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  replaced_by uuid,
  user_agent varchar(512),
  ip varchar(64)
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_family_id_idx ON sessions(family_id);

ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS business_id uuid,
  ADD COLUMN IF NOT EXISTS branch_id uuid,
  ADD COLUMN IF NOT EXISTS actor_type varchar(24) NOT NULL DEFAULT 'HUMAN',
  ADD COLUMN IF NOT EXISTS source varchar(64),
  ADD COLUMN IF NOT EXISTS ip varchar(64),
  ADD COLUMN IF NOT EXISTS user_agent varchar(512);

INSERT INTO permissions (id, code, description) VALUES
  ('11111111-1111-4111-8111-111111111110'::uuid, 'org.settings.manage', 'Manage organization-level settings'),
  ('11111111-1111-4111-8111-111111111111'::uuid, 'business.settings.manage', 'Manage business-level settings'),
  ('11111111-1111-4111-8111-111111111112'::uuid, 'branch.settings.manage', 'Manage branch-level settings')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role, permission_id) VALUES
  ('OWNER', '11111111-1111-4111-8111-111111111110'::uuid),
  ('OWNER', '11111111-1111-4111-8111-111111111111'::uuid),
  ('OWNER', '11111111-1111-4111-8111-111111111112'::uuid),
  ('ADMINISTRATOR', '11111111-1111-4111-8111-111111111110'::uuid),
  ('ADMINISTRATOR', '11111111-1111-4111-8111-111111111111'::uuid),
  ('ADMINISTRATOR', '11111111-1111-4111-8111-111111111112'::uuid),
  ('MANAGER', '11111111-1111-4111-8111-111111111112'::uuid)
ON CONFLICT DO NOTHING;
