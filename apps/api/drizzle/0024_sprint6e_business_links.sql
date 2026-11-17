-- Sprint 6e: a business's own link name and public page (ADR-024).
-- Links read bizora.app/<handle>/r/<token>; the page bizora.app/<handle> shows who the business is.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS handle varchar(40);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS about varchar(280);

-- Existing companies get a name from their own: "Ada Stores" → ada-stores. Where two would clash, or the name is
-- kept for Bizora's own pages, a short piece of the company id is added.
WITH base AS (
  SELECT
    id,
    created_at,
    left(trim(both '-' FROM regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')), 30) AS b
  FROM organizations
  WHERE handle IS NULL
),
cleaned AS (
  SELECT id, created_at, CASE WHEN length(trim(both '-' FROM b)) >= 3 THEN trim(both '-' FROM b) ELSE 'business' END AS b
  FROM base
),
numbered AS (
  SELECT id, b, row_number() OVER (PARTITION BY b ORDER BY created_at, id) AS n FROM cleaned
)
UPDATE organizations o
SET handle = CASE
  WHEN numbered.n = 1
    AND numbered.b NOT IN ('about','account','admin','api','app','apps','assets','auth','billing','blog','bizora','business','careers','contact','dashboard','docs','download','favicon','features','health','help','home','icon','invite','invoice','invoices','join','legal','login','logout','manifest','news','offline','pay','payment','payments','press','pricing','privacy','providers','ready','receipt','receipts','register','reset','robots','screens','security','select-workspace','settings','shop','signin','signup','sitemap','statement','statements','status','store','support','sw','team','terms','verify','welcome','www','zora')
    AND NOT EXISTS (SELECT 1 FROM organizations other WHERE other.handle = numbered.b)
    THEN numbered.b
  ELSE numbered.b || '-' || left(replace(o.id::text, '-', ''), 6)
END
FROM numbered
WHERE o.id = numbered.id;

CREATE UNIQUE INDEX IF NOT EXISTS organizations_handle_key ON organizations (handle);
ALTER TABLE organizations ALTER COLUMN handle SET NOT NULL;
ALTER TABLE organizations ADD CONSTRAINT organizations_handle_format_ck CHECK (handle ~ '^[a-z0-9]([a-z0-9]|-[a-z0-9]){2,39}$');
