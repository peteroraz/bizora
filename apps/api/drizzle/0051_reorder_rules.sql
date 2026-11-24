-- ADR-063: reorder rules. The reorder point for every shop stays the product's low stock level; a rule adds the
-- minimum, target and maximum, the usual supplier and how long they take, for every shop or for one shop.
CREATE TABLE IF NOT EXISTS reorder_rules (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  product_id uuid NOT NULL,
  -- Empty: the rule for every shop. A shop's own rule replaces it there.
  branch_id uuid,
  -- Only a shop's own rule has its own reorder point; for every shop it is products.low_stock_level.
  reorder_point bigint,
  min_quantity bigint,
  target_quantity bigint,
  max_quantity bigint,
  lead_time_days integer,
  preferred_supplier_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT reorder_rules_product_fk FOREIGN KEY (tenant_id, business_id, product_id) REFERENCES products (tenant_id, business_id, id),
  CONSTRAINT reorder_rules_branch_fk FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  CONSTRAINT reorder_rules_point_ck CHECK ((branch_id IS NULL AND reorder_point IS NULL) OR (branch_id IS NOT NULL AND reorder_point IS NOT NULL)),
  CONSTRAINT reorder_rules_quantities_ck CHECK (
    coalesce(reorder_point, 0) >= 0 AND coalesce(min_quantity, 0) >= 0 AND coalesce(target_quantity, 1) > 0 AND coalesce(max_quantity, 1) > 0
    AND (target_quantity IS NULL OR max_quantity IS NULL OR max_quantity >= target_quantity)
  ),
  CONSTRAINT reorder_rules_lead_ck CHECK (lead_time_days IS NULL OR lead_time_days BETWEEN 0 AND 365)
);
CREATE UNIQUE INDEX IF NOT EXISTS reorder_rules_key ON reorder_rules (tenant_id, product_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS reorder_rules_branch_idx ON reorder_rules (tenant_id, branch_id) WHERE branch_id IS NOT NULL;
