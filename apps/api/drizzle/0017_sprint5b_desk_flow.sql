-- Sprint 5b: the "sales desk -> cashier -> store" way of selling (ADR-016).
-- A business chooses: simple (one person records and takes payment) or desk (sales person, then cashier, then store keeper).

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS sales_flow varchar(10) NOT NULL DEFAULT 'simple';
ALTER TABLE businesses DROP CONSTRAINT IF EXISTS businesses_sales_flow_ck;
ALTER TABLE businesses ADD CONSTRAINT businesses_sales_flow_ck CHECK (sales_flow IN ('simple', 'desk'));

-- Credit is given only to customers a manager or owner approved, up to their limit (no limit when empty).
ALTER TABLE customers ADD COLUMN IF NOT EXISTS credit_allowed boolean NOT NULL DEFAULT false;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS credit_limit_minor bigint;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS credit_approved_by uuid;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS credit_approved_at timestamptz;
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_credit_limit_ck;
ALTER TABLE customers ADD CONSTRAINT customers_credit_limit_ck CHECK (credit_limit_minor IS NULL OR credit_limit_minor >= 0);
-- Customers who already bought on credit keep being able to.
UPDATE customers SET credit_allowed = true, credit_approved_at = now() WHERE EXISTS (SELECT 1 FROM sales WHERE sales.tenant_id = customers.tenant_id AND sales.customer_id = customers.id AND sales.balance_minor > 0 AND NOT sales.history_only);

-- Sale stages. Simple sales are completed at once; desk sales wait for the cashier, then the store keeper.
ALTER TABLE sales ALTER COLUMN status TYPE varchar(20);
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_status_ck;
ALTER TABLE sales ADD CONSTRAINT sales_status_ck CHECK (status IN ('awaiting_payment', 'awaiting_release', 'completed', 'voided'));
ALTER TABLE sales ADD COLUMN IF NOT EXISTS requested_payment varchar(10);
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_requested_payment_ck;
ALTER TABLE sales ADD CONSTRAINT sales_requested_payment_ck CHECK (requested_payment IS NULL OR requested_payment IN ('cash', 'transfer', 'pos', 'split', 'credit'));
ALTER TABLE sales ADD COLUMN IF NOT EXISTS due_date date;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS collected_at timestamptz;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS collected_by uuid;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS collected_membership_id uuid;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS released_at timestamptz;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS released_by uuid;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS released_membership_id uuid;
UPDATE sales SET collected_at = created_at, collected_by = created_by, collected_membership_id = membership_id, released_at = created_at, released_by = created_by, released_membership_id = membership_id WHERE collected_at IS NULL AND NOT history_only;
-- Until the cashier has taken payment, the whole total is unpaid and no customer is needed yet.
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_credit_customer_ck;
ALTER TABLE sales ADD CONSTRAINT sales_credit_customer_ck CHECK (balance_minor = 0 OR customer_id IS NOT NULL OR history_only OR collected_at IS NULL);
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_unpaid_ck;
ALTER TABLE sales ADD CONSTRAINT sales_unpaid_ck CHECK (status <> 'awaiting_payment' OR (paid_minor = 0 AND collected_at IS NULL));
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_released_ck;
ALTER TABLE sales ADD CONSTRAINT sales_released_ck CHECK (status <> 'completed' OR history_only OR released_at IS NOT NULL);
CREATE INDEX IF NOT EXISTS sales_queue_idx ON sales (tenant_id, branch_id, status, created_at);

-- Comments on a sale from the sales person, cashier and store keeper. They cannot be changed or deleted.
CREATE TABLE IF NOT EXISTS sale_comments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  sale_id uuid NOT NULL,
  user_id uuid,
  membership_id uuid,
  role varchar(24),
  kind varchar(12) NOT NULL DEFAULT 'comment',
  body varchar(500) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sale_comments_kind_ck CHECK (kind IN ('comment', 'credit')),
  CONSTRAINT sale_comments_body_ck CHECK (length(btrim(body)) > 0),
  CONSTRAINT sale_comments_sale_fk FOREIGN KEY (tenant_id, business_id, sale_id) REFERENCES sales (tenant_id, business_id, id)
);
CREATE INDEX IF NOT EXISTS sale_comments_sale_idx ON sale_comments (tenant_id, sale_id, created_at);
CREATE OR REPLACE FUNCTION bizora_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% rows cannot be changed or deleted.', TG_TABLE_NAME USING ERRCODE = '55000'; END $$;
DROP TRIGGER IF EXISTS sale_comments_immutable ON sale_comments;
CREATE TRIGGER sale_comments_immutable BEFORE UPDATE OR DELETE ON sale_comments FOR EACH ROW EXECUTE FUNCTION bizora_append_only();

-- In-app notifications for one person (one membership).
CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  kind varchar(32) NOT NULL,
  sale_id uuid,
  actor_name varchar(160),
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_membership_fk FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships (tenant_id, id),
  CONSTRAINT notifications_sale_fk FOREIGN KEY (tenant_id, sale_id) REFERENCES sales (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS notifications_inbox_idx ON notifications (tenant_id, membership_id, created_at DESC);

INSERT INTO permissions (id, code, description) VALUES
  ('11111111-1111-4111-8111-111111111146'::uuid, 'sales.collect', 'Take payment for sales waiting at the cashier'),
  ('11111111-1111-4111-8111-111111111147'::uuid, 'sales.release', 'Give out goods for paid or approved sales'),
  ('11111111-1111-4111-8111-111111111148'::uuid, 'sales.credit', 'Sell on credit to customers approved for credit, within their limit')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role, permission_id)
SELECT grants.role, permissions.id FROM (VALUES
  ('OWNER', 'sales.collect'),
  ('OWNER', 'sales.release'),
  ('OWNER', 'sales.credit'),
  ('ADMINISTRATOR', 'sales.collect'),
  ('ADMINISTRATOR', 'sales.release'),
  ('ADMINISTRATOR', 'sales.credit'),
  ('MANAGER', 'sales.collect'),
  ('MANAGER', 'sales.release'),
  ('MANAGER', 'sales.credit'),
  ('CASHIER', 'sales.collect'),
  ('CASHIER', 'sales.credit'),
  ('INVENTORY', 'sales.release')
) AS grants (role, code) JOIN permissions ON permissions.code = grants.code
WHERE NOT EXISTS (SELECT 1 FROM role_permissions existing WHERE existing.role = grants.role AND existing.permission_id = permissions.id);
