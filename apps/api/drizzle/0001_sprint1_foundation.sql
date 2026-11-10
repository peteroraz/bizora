CREATE TABLE IF NOT EXISTS schema_migrations (
  id varchar(255) PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY,
  name varchar(160) NOT NULL,
  slug varchar(160) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  email varchar(320) NOT NULL UNIQUE,
  password_hash varchar(255) NOT NULL,
  display_name varchar(120) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid
);

CREATE TABLE IF NOT EXISTS businesses (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organizations(id),
  name varchar(160) NOT NULL,
  country_code char(2) NOT NULL,
  base_currency_code char(3) NOT NULL,
  timezone varchar(64) NOT NULL,
  industry_code varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid
);

CREATE INDEX IF NOT EXISTS businesses_tenant_id_idx ON businesses(tenant_id);

CREATE TABLE IF NOT EXISTS branches (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organizations(id),
  business_id uuid NOT NULL REFERENCES businesses(id),
  name varchar(160) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid
);

CREATE INDEX IF NOT EXISTS branches_tenant_id_idx ON branches(tenant_id);
CREATE INDEX IF NOT EXISTS branches_business_id_idx ON branches(business_id);

CREATE TABLE IF NOT EXISTS memberships (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role varchar(32) NOT NULL,
  business_id uuid REFERENCES businesses(id),
  branch_id uuid REFERENCES branches(id),
  status varchar(24) NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid
);

CREATE UNIQUE INDEX IF NOT EXISTS memberships_tenant_user_idx ON memberships(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS memberships_user_id_idx ON memberships(user_id);

CREATE TABLE IF NOT EXISTS permissions (
  id uuid PRIMARY KEY,
  code varchar(64) NOT NULL UNIQUE,
  description varchar(255) NOT NULL
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role varchar(32) NOT NULL,
  permission_id uuid NOT NULL REFERENCES permissions(id),
  PRIMARY KEY (role, permission_id)
);

CREATE TABLE IF NOT EXISTS country_packs (
  code char(2) PRIMARY KEY,
  name varchar(120) NOT NULL,
  default_currency_code char(3) NOT NULL,
  default_timezone varchar(64) NOT NULL
);

CREATE TABLE IF NOT EXISTS industry_packs (
  code varchar(64) PRIMARY KEY,
  name varchar(120) NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY,
  tenant_id uuid,
  actor_user_id uuid,
  action varchar(64) NOT NULL,
  entity_type varchar(64) NOT NULL,
  entity_id uuid,
  correlation_id varchar(64) NOT NULL,
  metadata_json text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_events_tenant_id_idx ON audit_events(tenant_id);
CREATE INDEX IF NOT EXISTS audit_events_correlation_id_idx ON audit_events(correlation_id);
