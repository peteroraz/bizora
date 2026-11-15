-- Sprint 3C.5a: staff without email (PIN on enrolled shop devices), plan entitlements,
-- and new permissions. Addendum v1.2 §5, §6, §12.

-- 1. Users: staff users have no email and no password; people keep both rules as before.
ALTER TABLE users ADD COLUMN IF NOT EXISTS kind varchar(16) NOT NULL DEFAULT 'person';
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;

-- The migration runner splits statements on a trailing semicolon, so no multi-line DO blocks.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_kind_ck;
ALTER TABLE users ADD CONSTRAINT users_kind_ck CHECK (kind IN ('person', 'staff'));
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_person_email_ck;
ALTER TABLE users ADD CONSTRAINT users_person_email_ck CHECK (kind = 'staff' OR email IS NOT NULL);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_staff_no_credentials_ck;
ALTER TABLE users ADD CONSTRAINT users_staff_no_credentials_ck
  CHECK (kind = 'person' OR (email IS NULL AND password_hash IS NULL));

-- Optional phone for a membership (used for shop staff who have no email).
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS phone_e164 varchar(20);

-- 2. Shop devices (enrolled by an owner/manager for one branch).
CREATE TABLE IF NOT EXISTS shop_devices (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  name varchar(80) NOT NULL,
  token_hash varchar(64) NOT NULL UNIQUE,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  suspended_at timestamptz,
  attempts_reset_at timestamptz,
  CONSTRAINT shop_devices_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT shop_devices_business_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT shop_devices_branch_fk FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS shop_devices_tenant_branch_idx ON shop_devices (tenant_id, branch_id);

-- 3. Staff PIN credentials (one per staff membership).
CREATE TABLE IF NOT EXISTS staff_credentials (
  membership_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users (id),
  pin_hash varchar(255) NOT NULL,
  pin_updated_at timestamptz NOT NULL DEFAULT now(),
  attempts_reset_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_credentials_membership_fk FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships (tenant_id, id)
);

-- 4. PIN attempts (used for per-staff lockout and per-device suspension).
CREATE TABLE IF NOT EXISTS staff_pin_attempts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  membership_id uuid,
  succeeded boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_pin_attempts_device_fk FOREIGN KEY (tenant_id, device_id) REFERENCES shop_devices (tenant_id, id),
  CONSTRAINT staff_pin_attempts_membership_fk FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS staff_pin_attempts_device_member_idx ON staff_pin_attempts (device_id, membership_id, created_at);
CREATE INDEX IF NOT EXISTS staff_pin_attempts_device_idx ON staff_pin_attempts (device_id, created_at);

-- 5. Sessions created by PIN login are bound to the shop device.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS device_id uuid;
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_tenant_device_fk;
ALTER TABLE sessions ADD CONSTRAINT sessions_tenant_device_fk
  FOREIGN KEY (tenant_id, device_id) REFERENCES shop_devices (tenant_id, id);
CREATE INDEX IF NOT EXISTS sessions_device_id_idx ON sessions (device_id);

-- 6. Plans and entitlements (no billing yet).
CREATE TABLE IF NOT EXISTS plans (
  code varchar(32) PRIMARY KEY,
  name varchar(80) NOT NULL,
  limits jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organization_plans (
  tenant_id uuid PRIMARY KEY REFERENCES organizations (id),
  plan_code varchar(32) NOT NULL REFERENCES plans (code),
  started_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO plans (code, name, limits) VALUES
  ('starter', 'Starter', '{"max_branches": 1, "max_staff": 2, "max_devices": 2, "features": {"multi_currency": true, "whatsapp_automation": false, "advanced_reports": false, "ai": false, "integrations": false}}'::jsonb),
  ('business', 'Business', '{"max_branches": 5, "max_staff": 25, "max_devices": 10, "features": {"multi_currency": true, "whatsapp_automation": true, "advanced_reports": true, "ai": false, "integrations": true}}'::jsonb)
ON CONFLICT (code) DO NOTHING;

INSERT INTO organization_plans (tenant_id, plan_code)
SELECT id, 'starter' FROM organizations
ON CONFLICT (tenant_id) DO NOTHING;

-- 7. Permissions.
INSERT INTO permissions (id, code, description) VALUES
  ('11111111-1111-4111-8111-111111111116'::uuid, 'prices.cost.read', 'See cost prices'),
  ('11111111-1111-4111-8111-111111111117'::uuid, 'reports.profit.read', 'See profit reports'),
  ('11111111-1111-4111-8111-111111111118'::uuid, 'staff.manage', 'Create shop staff, reset PINs, deactivate staff'),
  ('11111111-1111-4111-8111-111111111119'::uuid, 'devices.manage', 'Turn on Shop mode and manage shop devices')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role, permission_id) VALUES
  ('OWNER', '11111111-1111-4111-8111-111111111116'::uuid),
  ('OWNER', '11111111-1111-4111-8111-111111111117'::uuid),
  ('OWNER', '11111111-1111-4111-8111-111111111118'::uuid),
  ('OWNER', '11111111-1111-4111-8111-111111111119'::uuid),
  ('ADMINISTRATOR', '11111111-1111-4111-8111-111111111116'::uuid),
  ('ADMINISTRATOR', '11111111-1111-4111-8111-111111111117'::uuid),
  ('ADMINISTRATOR', '11111111-1111-4111-8111-111111111118'::uuid),
  ('ADMINISTRATOR', '11111111-1111-4111-8111-111111111119'::uuid),
  ('MANAGER', '11111111-1111-4111-8111-111111111116'::uuid),
  ('MANAGER', '11111111-1111-4111-8111-111111111117'::uuid),
  ('MANAGER', '11111111-1111-4111-8111-111111111118'::uuid),
  ('MANAGER', '11111111-1111-4111-8111-111111111119'::uuid),
  ('ACCOUNTANT', '11111111-1111-4111-8111-111111111116'::uuid),
  ('ACCOUNTANT', '11111111-1111-4111-8111-111111111117'::uuid),
  ('AUDITOR', '11111111-1111-4111-8111-111111111116'::uuid),
  ('AUDITOR', '11111111-1111-4111-8111-111111111117'::uuid)
ON CONFLICT DO NOTHING;
