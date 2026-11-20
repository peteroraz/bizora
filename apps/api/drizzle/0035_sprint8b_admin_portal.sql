-- Sprint 8b (ADR-037): Bizora staff for the Admin portal, their sign-in sessions and their audit log.
-- Kept apart from businesses' users and memberships: a business sign-in can never open the portal.

CREATE TABLE IF NOT EXISTS admin_staff (
  id uuid PRIMARY KEY,
  email varchar(320) NOT NULL,
  name varchar(160) NOT NULL,
  roles text[] NOT NULL DEFAULT '{}'::text[],
  status varchar(12) NOT NULL DEFAULT 'active',
  google_subject varchar(255),
  last_sign_in_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  removed_at timestamptz,
  removed_by uuid,
  CONSTRAINT admin_staff_status_ck CHECK (status IN ('active', 'removed')),
  CONSTRAINT admin_staff_roles_ck CHECK (roles <@ ARRAY['super_admin', 'support', 'operations', 'finance', 'viewer']::text[])
);
CREATE UNIQUE INDEX IF NOT EXISTS admin_staff_email_key ON admin_staff (lower(email));

CREATE TABLE IF NOT EXISTS admin_sessions (
  id uuid PRIMARY KEY,
  staff_id uuid NOT NULL REFERENCES admin_staff (id),
  token_hash char(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ip varchar(64),
  user_agent varchar(512),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS admin_sessions_token_key ON admin_sessions (token_hash);

CREATE TABLE IF NOT EXISTS admin_audit (
  id uuid PRIMARY KEY,
  staff_id uuid REFERENCES admin_staff (id),
  staff_email varchar(320) NOT NULL,
  action varchar(64) NOT NULL,
  target_type varchar(32),
  target_id uuid,
  tenant_id uuid,
  reason varchar(500),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip varchar(64),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_audit_created_idx ON admin_audit (created_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_tenant_idx ON admin_audit (tenant_id, created_at DESC);
