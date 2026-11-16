-- Sprint 5d: AI capture (ADR-018). Counts captures per organization per day, so AI costs stay within a daily limit.
-- Photos and voice notes are never stored; only these counts are.
CREATE TABLE IF NOT EXISTS ai_usage (
  tenant_id uuid NOT NULL REFERENCES organizations (id),
  day date NOT NULL,
  captures integer NOT NULL DEFAULT 0,
  input_bytes bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, day),
  CONSTRAINT ai_usage_counts_ck CHECK (captures >= 0 AND input_bytes >= 0)
);
