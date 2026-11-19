-- Sprint 7g (ADR-033): up to 5 photos a product. Kept in the database like the logo (ADR-021) for now; they can move
-- to Cloud Storage when the Admin portal shows storage per business.
CREATE TABLE IF NOT EXISTS product_photos (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  product_id uuid NOT NULL,
  position smallint NOT NULL,
  content_type varchar(20) NOT NULL,
  data bytea NOT NULL,
  byte_size integer NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  sha256 char(64) NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_photos_product_fk FOREIGN KEY (tenant_id, business_id, product_id) REFERENCES products (tenant_id, business_id, id),
  CONSTRAINT product_photos_position_ck CHECK (position >= 0 AND position < 5),
  CONSTRAINT product_photos_type_ck CHECK (content_type IN ('image/jpeg', 'image/png')),
  CONSTRAINT product_photos_size_ck CHECK (byte_size > 0 AND width > 0 AND height > 0)
);
CREATE INDEX IF NOT EXISTS product_photos_product_idx ON product_photos (tenant_id, product_id, position);
