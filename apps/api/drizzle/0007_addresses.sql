CREATE TABLE IF NOT EXISTS addresses (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  line1 varchar(200) NOT NULL,
  line2 varchar(200),
  city varchar(120) NOT NULL,
  subdivision_code varchar(16),
  postal_code varchar(32),
  country_code varchar(2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid
);

CREATE UNIQUE INDEX IF NOT EXISTS addresses_tenant_id_id_key ON addresses (tenant_id, id);
CREATE INDEX IF NOT EXISTS addresses_tenant_id_idx ON addresses (tenant_id);

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS address_id uuid;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS phone_e164 varchar(20);
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_address_fk;
ALTER TABLE organizations
  ADD CONSTRAINT organizations_address_fk
  FOREIGN KEY (id, address_id) REFERENCES addresses (tenant_id, id);

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS address_id uuid;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS phone_e164 varchar(20);
ALTER TABLE businesses DROP CONSTRAINT IF EXISTS businesses_address_fk;
ALTER TABLE businesses
  ADD CONSTRAINT businesses_address_fk
  FOREIGN KEY (tenant_id, address_id) REFERENCES addresses (tenant_id, id);

ALTER TABLE branches ADD COLUMN IF NOT EXISTS address_id uuid;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS phone_e164 varchar(20);
ALTER TABLE branches DROP CONSTRAINT IF EXISTS branches_address_fk;
ALTER TABLE branches
  ADD CONSTRAINT branches_address_fk
  FOREIGN KEY (tenant_id, address_id) REFERENCES addresses (tenant_id, id);
