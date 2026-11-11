ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS logo_url varchar(2048),
  ADD COLUMN IF NOT EXISTS primary_color varchar(7) NOT NULL DEFAULT '#1D4ED8',
  ADD COLUMN IF NOT EXISTS accent_color varchar(7) NOT NULL DEFAULT '#0F172A',
  ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz;

CREATE TABLE IF NOT EXISTS invitations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organizations(id),
  email varchar(320) NOT NULL,
  role varchar(32) NOT NULL,
  business_id uuid REFERENCES businesses(id),
  branch_id uuid REFERENCES branches(id),
  token_hash varchar(64) NOT NULL UNIQUE,
  status varchar(24) NOT NULL DEFAULT 'PENDING',
  expires_at timestamptz NOT NULL,
  invited_by uuid NOT NULL,
  accepted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid
);

CREATE INDEX IF NOT EXISTS invitations_tenant_id_idx ON invitations(tenant_id);
CREATE INDEX IF NOT EXISTS invitations_email_idx ON invitations(email);

INSERT INTO country_packs (code, name, default_currency_code, default_timezone) VALUES
  ('NG', 'Nigeria', 'NGN', 'Africa/Lagos'),
  ('GB', 'United Kingdom', 'GBP', 'Europe/London'),
  ('US', 'United States', 'USD', 'America/New_York'),
  ('KE', 'Kenya', 'KES', 'Africa/Nairobi'),
  ('ZA', 'South Africa', 'ZAR', 'Africa/Johannesburg'),
  ('GH', 'Ghana', 'GHS', 'Africa/Accra')
ON CONFLICT (code) DO NOTHING;

INSERT INTO industry_packs (code, name) VALUES
  ('general-retail', 'General Retail'),
  ('professional-services', 'Professional Services'),
  ('hospitality', 'Hospitality'),
  ('wholesale', 'Wholesale'),
  ('healthcare-clinic', 'Clinic / Healthcare practice')
ON CONFLICT (code) DO NOTHING;

INSERT INTO permissions (id, code, description) VALUES
  ('11111111-1111-4111-8111-111111111101'::uuid, 'tenant.read', 'Read tenant configuration'),
  ('11111111-1111-4111-8111-111111111102'::uuid, 'tenant.manage', 'Manage tenant and business settings'),
  ('11111111-1111-4111-8111-111111111103'::uuid, 'branding.manage', 'Manage logo and brand colors'),
  ('11111111-1111-4111-8111-111111111104'::uuid, 'users.read', 'List users and invitations'),
  ('11111111-1111-4111-8111-111111111105'::uuid, 'users.invite', 'Invite users'),
  ('11111111-1111-4111-8111-111111111106'::uuid, 'users.manage', 'Change membership roles and status'),
  ('11111111-1111-4111-8111-111111111107'::uuid, 'onboarding.complete', 'Complete first-run onboarding'),
  ('11111111-1111-4111-8111-111111111108'::uuid, 'branches.read', 'Read branches'),
  ('11111111-1111-4111-8111-111111111109'::uuid, 'branches.manage', 'Create and update branches')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role, permission_id) VALUES
  ('OWNER', '11111111-1111-4111-8111-111111111101'::uuid),
  ('OWNER', '11111111-1111-4111-8111-111111111102'::uuid),
  ('OWNER', '11111111-1111-4111-8111-111111111103'::uuid),
  ('OWNER', '11111111-1111-4111-8111-111111111104'::uuid),
  ('OWNER', '11111111-1111-4111-8111-111111111105'::uuid),
  ('OWNER', '11111111-1111-4111-8111-111111111106'::uuid),
  ('OWNER', '11111111-1111-4111-8111-111111111107'::uuid),
  ('OWNER', '11111111-1111-4111-8111-111111111108'::uuid),
  ('OWNER', '11111111-1111-4111-8111-111111111109'::uuid),
  ('ADMINISTRATOR', '11111111-1111-4111-8111-111111111101'::uuid),
  ('ADMINISTRATOR', '11111111-1111-4111-8111-111111111102'::uuid),
  ('ADMINISTRATOR', '11111111-1111-4111-8111-111111111103'::uuid),
  ('ADMINISTRATOR', '11111111-1111-4111-8111-111111111104'::uuid),
  ('ADMINISTRATOR', '11111111-1111-4111-8111-111111111105'::uuid),
  ('ADMINISTRATOR', '11111111-1111-4111-8111-111111111106'::uuid),
  ('ADMINISTRATOR', '11111111-1111-4111-8111-111111111107'::uuid),
  ('ADMINISTRATOR', '11111111-1111-4111-8111-111111111108'::uuid),
  ('ADMINISTRATOR', '11111111-1111-4111-8111-111111111109'::uuid),
  ('MANAGER', '11111111-1111-4111-8111-111111111101'::uuid),
  ('MANAGER', '11111111-1111-4111-8111-111111111104'::uuid),
  ('MANAGER', '11111111-1111-4111-8111-111111111108'::uuid),
  ('MANAGER', '11111111-1111-4111-8111-111111111109'::uuid),
  ('SALES', '11111111-1111-4111-8111-111111111101'::uuid),
  ('SALES', '11111111-1111-4111-8111-111111111108'::uuid),
  ('CASHIER', '11111111-1111-4111-8111-111111111101'::uuid),
  ('CASHIER', '11111111-1111-4111-8111-111111111108'::uuid),
  ('INVENTORY', '11111111-1111-4111-8111-111111111101'::uuid),
  ('INVENTORY', '11111111-1111-4111-8111-111111111108'::uuid),
  ('ACCOUNTANT', '11111111-1111-4111-8111-111111111101'::uuid),
  ('ACCOUNTANT', '11111111-1111-4111-8111-111111111108'::uuid),
  ('EMPLOYEE', '11111111-1111-4111-8111-111111111101'::uuid),
  ('EMPLOYEE', '11111111-1111-4111-8111-111111111108'::uuid),
  ('AUDITOR', '11111111-1111-4111-8111-111111111101'::uuid),
  ('AUDITOR', '11111111-1111-4111-8111-111111111104'::uuid),
  ('AUDITOR', '11111111-1111-4111-8111-111111111108'::uuid)
ON CONFLICT DO NOTHING;
