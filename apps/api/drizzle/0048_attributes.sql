-- ADR-060: product attributes (Colour, Size, Storage…) defined per business, with options, set on each variant.
CREATE TABLE IF NOT EXISTS attribute_definitions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  name varchar(60) NOT NULL,
  name_key varchar(60) NOT NULL,
  kind varchar(12) NOT NULL,
  unit varchar(16),
  position integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT attribute_definitions_business_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT attribute_definitions_kind_ck CHECK (kind IN ('text', 'number', 'select', 'multi_select', 'boolean'))
);
CREATE UNIQUE INDEX IF NOT EXISTS attribute_definitions_tenant_business_id_key ON attribute_definitions (tenant_id, business_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS attribute_definitions_name_key ON attribute_definitions (tenant_id, business_id, name_key);

CREATE TABLE IF NOT EXISTS attribute_options (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  attribute_id uuid NOT NULL,
  value varchar(60) NOT NULL,
  value_key varchar(60) NOT NULL,
  position integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attribute_options_attribute_fk FOREIGN KEY (tenant_id, business_id, attribute_id) REFERENCES attribute_definitions (tenant_id, business_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS attribute_options_tenant_business_id_key ON attribute_options (tenant_id, business_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS attribute_options_value_key ON attribute_options (tenant_id, attribute_id, value_key);

CREATE TABLE IF NOT EXISTS variant_attribute_values (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  product_id uuid NOT NULL,
  attribute_id uuid NOT NULL,
  option_id uuid,
  text_value varchar(120),
  number_value numeric(18, 4),
  bool_value boolean,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT variant_attribute_values_product_fk FOREIGN KEY (tenant_id, business_id, product_id) REFERENCES products (tenant_id, business_id, id),
  CONSTRAINT variant_attribute_values_attribute_fk FOREIGN KEY (tenant_id, business_id, attribute_id) REFERENCES attribute_definitions (tenant_id, business_id, id),
  CONSTRAINT variant_attribute_values_option_fk FOREIGN KEY (tenant_id, business_id, option_id) REFERENCES attribute_options (tenant_id, business_id, id),
  CONSTRAINT variant_attribute_values_one_ck CHECK ((option_id IS NOT NULL)::int + (text_value IS NOT NULL)::int + (number_value IS NOT NULL)::int + (bool_value IS NOT NULL)::int = 1)
);
-- One value per product and attribute, except a multi-select, which has one row per option chosen.
CREATE UNIQUE INDEX IF NOT EXISTS variant_attribute_values_key ON variant_attribute_values (tenant_id, product_id, attribute_id, coalesce(option_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS variant_attribute_values_option_idx ON variant_attribute_values (tenant_id, option_id);
