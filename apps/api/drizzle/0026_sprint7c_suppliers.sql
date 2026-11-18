-- Sprint 7c: suppliers and what is owed to them (ADR-029).

CREATE TABLE IF NOT EXISTS suppliers (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  name varchar(160) NOT NULL,
  phone_e164 varchar(20),
  notes varchar(240),
  -- The one "Supplier not named" per business, for stock received on credit with no supplier given.
  unnamed boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT suppliers_business_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS suppliers_tenant_id_id_key ON suppliers (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS suppliers_name_key ON suppliers (tenant_id, business_id, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS suppliers_unnamed_key ON suppliers (tenant_id, business_id) WHERE unnamed;

-- What a supplier is owed, line by line: purchases and opening amounts add to it, payments take it down.
-- Each line points at the ledger entry that moved "Suppliers we owe" by the same amount.
CREATE TABLE IF NOT EXISTS supplier_entries (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  branch_id uuid,
  kind varchar(10) NOT NULL,
  amount_minor bigint NOT NULL,
  currency_code char(3) NOT NULL,
  entry_date date NOT NULL,
  pay_by date,
  paid_from varchar(10),
  stock_movement_id uuid,
  note varchar(240),
  status varchar(10) NOT NULL DEFAULT 'recorded',
  journal_entry_id uuid,
  voided_at timestamptz,
  voided_by uuid,
  void_reason varchar(240),
  created_by uuid,
  membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_entries_amount_ck CHECK (amount_minor > 0),
  CONSTRAINT supplier_entries_kind_ck CHECK (kind IN ('purchase', 'opening', 'payment')),
  CONSTRAINT supplier_entries_status_ck CHECK (status IN ('recorded', 'voided')),
  CONSTRAINT supplier_entries_paid_from_ck CHECK (paid_from IS NULL OR paid_from IN ('cash', 'bank', 'owner')),
  CONSTRAINT supplier_entries_business_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT supplier_entries_supplier_fk FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS supplier_entries_tenant_id_id_key ON supplier_entries (tenant_id, id);
CREATE INDEX IF NOT EXISTS supplier_entries_supplier_idx ON supplier_entries (tenant_id, supplier_id, entry_date DESC);
CREATE UNIQUE INDEX IF NOT EXISTS supplier_entries_movement_key ON supplier_entries (tenant_id, stock_movement_id) WHERE stock_movement_id IS NOT NULL;

ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS supplier_id uuid;
CREATE INDEX IF NOT EXISTS stock_movements_supplier_idx ON stock_movements (tenant_id, supplier_id, created_at DESC) WHERE supplier_id IS NOT NULL;

-- Suppliers from the names already typed on stock in, one per name (any capitals) per business.
INSERT INTO suppliers (id, tenant_id, business_id, name)
SELECT gen_random_uuid(), tenant_id, business_id, min(trim(supplier))
FROM stock_movements
WHERE movement_type = 'received' AND supplier IS NOT NULL AND length(trim(supplier)) >= 2
GROUP BY tenant_id, business_id, lower(trim(supplier))
ON CONFLICT DO NOTHING;

-- "Supplier not named" for stock already received on credit with no supplier.
INSERT INTO suppliers (id, tenant_id, business_id, name, unnamed)
SELECT gen_random_uuid(), tenant_id, business_id, 'Supplier not named', true
FROM stock_movements
WHERE movement_type = 'received' AND coalesce(paid_from, 'credit') = 'credit' AND value_minor > 0
  AND (supplier IS NULL OR length(trim(supplier)) < 2)
GROUP BY tenant_id, business_id
ON CONFLICT DO NOTHING;

-- Stock movements are append-only (0015). Filling in the new supplier column once, for history, is the one
-- change allowed; nothing else about a movement changes.
ALTER TABLE stock_movements DISABLE TRIGGER stock_movements_immutable;

UPDATE stock_movements m SET supplier_id = s.id
FROM suppliers s
WHERE m.movement_type = 'received' AND m.supplier_id IS NULL AND m.supplier IS NOT NULL
  AND s.tenant_id = m.tenant_id AND s.business_id = m.business_id AND NOT s.unnamed
  AND lower(s.name) = lower(trim(m.supplier));

UPDATE stock_movements m SET supplier_id = s.id
FROM suppliers s
WHERE m.movement_type = 'received' AND m.supplier_id IS NULL AND coalesce(m.paid_from, 'credit') = 'credit' AND m.value_minor > 0
  AND s.tenant_id = m.tenant_id AND s.business_id = m.business_id AND s.unnamed;

ALTER TABLE stock_movements ENABLE TRIGGER stock_movements_immutable;

-- What each supplier is owed for stock already received on credit (it is already in "Suppliers we owe").
INSERT INTO supplier_entries (id, tenant_id, business_id, supplier_id, branch_id, kind, amount_minor, currency_code, entry_date,
  stock_movement_id, journal_entry_id, created_by, membership_id, created_at)
SELECT gen_random_uuid(), m.tenant_id, m.business_id, m.supplier_id, m.branch_id, 'purchase', m.value_minor, b.base_currency_code,
  (m.occurred_at AT TIME ZONE b.timezone)::date, m.id, m.journal_entry_id, m.created_by, m.membership_id, m.created_at
FROM stock_movements m
JOIN businesses b ON b.tenant_id = m.tenant_id AND b.id = m.business_id
WHERE m.movement_type = 'received' AND coalesce(m.paid_from, 'credit') = 'credit' AND m.value_minor > 0
  AND m.supplier_id IS NOT NULL AND m.journal_entry_id IS NOT NULL
ON CONFLICT DO NOTHING;
