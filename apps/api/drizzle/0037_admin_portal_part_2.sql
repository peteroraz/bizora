-- ADR-039: the Terms of use each owner accepts, the support view Bizora staff open on a business, and limits set
-- for one business in the Admin portal.

CREATE TABLE IF NOT EXISTS terms_acceptances (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id),
  tenant_id uuid REFERENCES organizations (id),
  version varchar(20) NOT NULL,
  method varchar(16) NOT NULL,
  ip varchar(64),
  user_agent varchar(512),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT terms_acceptances_method_ck CHECK (method IN ('sign_up', 'in_app'))
);
CREATE UNIQUE INDEX IF NOT EXISTS terms_acceptances_user_version_key ON terms_acceptances (user_id, version);

CREATE TABLE IF NOT EXISTS admin_support_views (
  id uuid PRIMARY KEY,
  staff_id uuid NOT NULL REFERENCES admin_staff (id),
  tenant_id uuid NOT NULL REFERENCES organizations (id),
  reason varchar(500) NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  closed_at timestamptz
);
CREATE INDEX IF NOT EXISTS admin_support_views_open_idx ON admin_support_views (staff_id, tenant_id, expires_at);

-- Only the limits set here; anything missing falls back to the plan.
ALTER TABLE organization_plans ADD COLUMN IF NOT EXISTS limit_overrides jsonb NOT NULL DEFAULT '{}'::jsonb;
