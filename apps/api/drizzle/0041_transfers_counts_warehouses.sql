-- ADR-047: warehouses, transfers with a lifecycle, and count sessions. Every change to stock still goes through
-- stock_movements (ADR-014); these tables say why and when, and link to the movements.

-- A warehouse is a branch that keeps stock but does not sell at the counter.
ALTER TABLE branches ADD COLUMN IF NOT EXISTS kind varchar(12) NOT NULL DEFAULT 'shop';
ALTER TABLE branches ADD CONSTRAINT branches_kind_ck CHECK (kind IN ('shop', 'warehouse'));

-- A transfer: requested, approved, dispatched (stock leaves the sender and is in transit), received (stock arrives),
-- or cancelled before it left. The receiving branch's stock never rises before it is received.
CREATE TABLE IF NOT EXISTS stock_transfers (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  from_branch_id uuid NOT NULL,
  to_branch_id uuid NOT NULL,
  status varchar(12) NOT NULL,
  document_number varchar(24),
  note varchar(240),
  requested_by uuid,
  requested_membership_id uuid,
  requested_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid,
  approved_at timestamptz,
  dispatched_by uuid,
  dispatched_at timestamptz,
  received_by uuid,
  received_at timestamptz,
  receive_note varchar(240),
  cancelled_by uuid,
  cancelled_at timestamptz,
  cancel_reason varchar(240),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_transfers_business_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT stock_transfers_from_fk FOREIGN KEY (tenant_id, from_branch_id) REFERENCES branches (tenant_id, id),
  CONSTRAINT stock_transfers_to_fk FOREIGN KEY (tenant_id, to_branch_id) REFERENCES branches (tenant_id, id),
  CONSTRAINT stock_transfers_status_ck CHECK (status IN ('requested', 'approved', 'dispatched', 'received', 'cancelled')),
  CONSTRAINT stock_transfers_two_places_ck CHECK (from_branch_id <> to_branch_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS stock_transfers_tenant_business_id_key ON stock_transfers (tenant_id, business_id, id);
CREATE INDEX IF NOT EXISTS stock_transfers_from_idx ON stock_transfers (tenant_id, from_branch_id, status, requested_at);
CREATE INDEX IF NOT EXISTS stock_transfers_to_idx ON stock_transfers (tenant_id, to_branch_id, status, requested_at);

CREATE TABLE IF NOT EXISTS stock_transfer_lines (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  transfer_id uuid NOT NULL,
  line_no smallint NOT NULL,
  product_id uuid NOT NULL,
  -- Thousandths of the product's base unit, as typed and as converted.
  quantity bigint NOT NULL,
  entered_quantity bigint NOT NULL,
  entered_unit varchar(16) NOT NULL,
  -- Cost value that left the sender when dispatched, carried to the receiver.
  value_minor bigint,
  received_quantity bigint,
  out_movement_id uuid,
  in_movement_id uuid,
  short_movement_id uuid,
  CONSTRAINT stock_transfer_lines_transfer_fk FOREIGN KEY (tenant_id, business_id, transfer_id) REFERENCES stock_transfers (tenant_id, business_id, id),
  CONSTRAINT stock_transfer_lines_product_fk FOREIGN KEY (tenant_id, business_id, product_id) REFERENCES products (tenant_id, business_id, id),
  CONSTRAINT stock_transfer_lines_quantity_ck CHECK (quantity > 0 AND (received_quantity IS NULL OR (received_quantity >= 0 AND received_quantity <= quantity)))
);
CREATE UNIQUE INDEX IF NOT EXISTS stock_transfer_lines_line_key ON stock_transfer_lines (transfer_id, line_no);
CREATE INDEX IF NOT EXISTS stock_transfer_lines_product_idx ON stock_transfer_lines (tenant_id, product_id);

-- A count session: many products counted in one place, then submitted, approved and posted together.
CREATE TABLE IF NOT EXISTS stock_count_sessions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  status varchar(12) NOT NULL DEFAULT 'counting',
  name varchar(80) NOT NULL,
  note varchar(240),
  created_by uuid,
  created_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  submitted_by uuid,
  submitted_at timestamptz,
  approved_by uuid,
  approved_at timestamptz,
  posted_at timestamptz,
  decision_note varchar(240),
  cancelled_by uuid,
  cancelled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_count_sessions_business_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
  CONSTRAINT stock_count_sessions_branch_fk FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  CONSTRAINT stock_count_sessions_status_ck CHECK (status IN ('draft', 'counting', 'submitted', 'approved', 'posted', 'cancelled'))
);
CREATE UNIQUE INDEX IF NOT EXISTS stock_count_sessions_tenant_business_id_key ON stock_count_sessions (tenant_id, business_id, id);
CREATE INDEX IF NOT EXISTS stock_count_sessions_branch_idx ON stock_count_sessions (tenant_id, branch_id, status, created_at);

CREATE TABLE IF NOT EXISTS stock_count_session_lines (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  business_id uuid NOT NULL,
  session_id uuid NOT NULL,
  product_id uuid NOT NULL,
  system_quantity bigint NOT NULL,
  counted_quantity bigint NOT NULL,
  difference bigint NOT NULL,
  entered_quantity bigint NOT NULL,
  entered_unit varchar(16) NOT NULL,
  reason varchar(20),
  note varchar(240),
  counted_by uuid,
  counted_membership_id uuid,
  device_id uuid,
  counted_at timestamptz NOT NULL,
  movement_id uuid,
  CONSTRAINT stock_count_session_lines_session_fk FOREIGN KEY (tenant_id, business_id, session_id) REFERENCES stock_count_sessions (tenant_id, business_id, id),
  CONSTRAINT stock_count_session_lines_product_fk FOREIGN KEY (tenant_id, business_id, product_id) REFERENCES products (tenant_id, business_id, id),
  CONSTRAINT stock_count_session_lines_reason_ck CHECK (reason IS NULL OR reason IN ('damaged', 'missing', 'count_correction', 'expired', 'other'))
);
-- One line per product per session: counting a product again replaces its line.
CREATE UNIQUE INDEX IF NOT EXISTS stock_count_session_lines_product_key ON stock_count_session_lines (session_id, product_id);

-- Movements already carry transfer_id and count_id: a transfer's movements carry the transfer's ID, and a session's
-- movements carry the ID of their count line.
