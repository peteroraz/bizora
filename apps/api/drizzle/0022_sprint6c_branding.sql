-- Sprint 6c: company branding on documents (ADR-021).

-- What the owner wants to say to customers on documents. Empty means nothing extra is printed.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS receipt_message varchar(300);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS invoice_message varchar(500);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS document_terms varchar(1000);

-- The company logo, kept in the database: it is small (at most 512 KB), backed up with the books,
-- and never fetched from another site. logo_url on organizations is no longer set or used.
CREATE TABLE IF NOT EXISTS organization_logos (
  tenant_id uuid PRIMARY KEY REFERENCES organizations (id) ON DELETE CASCADE,
  content_type varchar(20) NOT NULL,
  data bytea NOT NULL,
  byte_size integer NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  sha256 char(64) NOT NULL,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_logos_type_ck CHECK (content_type IN ('image/png', 'image/jpeg')),
  CONSTRAINT organization_logos_size_ck CHECK (byte_size BETWEEN 1 AND 524288 AND octet_length(data) = byte_size),
  CONSTRAINT organization_logos_dimensions_ck CHECK (width BETWEEN 16 AND 2000 AND height BETWEEN 16 AND 2000)
);
