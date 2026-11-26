-- Bizora can suspend a business (ADR-071). The state, its category and when it began live on the organization; the
-- note, case and who acted live only in the append-only event log, never in rows sent to the owner.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS bizora_hold varchar(12) NOT NULL DEFAULT 'none';
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS hold_reason_code varchar(24);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS hold_since timestamptz;
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_bizora_hold_ck;
ALTER TABLE organizations ADD CONSTRAINT organizations_bizora_hold_ck CHECK (
  (bizora_hold = 'none' AND hold_reason_code IS NULL AND hold_since IS NULL)
  OR (bizora_hold = 'suspended' AND hold_reason_code IN ('fraud', 'security', 'abuse', 'terms', 'ownership', 'regulatory', 'payment_dispute', 'other') AND hold_since IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS business_lifecycle_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organizations (id),
  field varchar(24) NOT NULL,
  from_value varchar(16) NOT NULL,
  to_value varchar(16) NOT NULL,
  reason_code varchar(24),
  note varchar(500) NOT NULL,
  case_ref varchar(64),
  review_on date,
  actor_staff_id uuid REFERENCES admin_staff (id),
  actor_staff_email varchar(320),
  actor_user_id uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT business_lifecycle_events_field_ck CHECK (field IN ('bizora_hold')),
  CONSTRAINT business_lifecycle_events_actor_ck CHECK (actor_staff_id IS NOT NULL OR actor_user_id IS NOT NULL),
  CONSTRAINT business_lifecycle_events_note_ck CHECK (char_length(note) >= 5)
);
CREATE INDEX IF NOT EXISTS business_lifecycle_events_tenant_idx ON business_lifecycle_events (tenant_id, created_at);
DROP TRIGGER IF EXISTS business_lifecycle_events_immutable ON business_lifecycle_events;
CREATE TRIGGER business_lifecycle_events_immutable BEFORE UPDATE OR DELETE ON business_lifecycle_events FOR EACH ROW EXECUTE FUNCTION bizora_append_only();
