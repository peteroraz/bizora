-- ADR-045: running the pilot.

-- Switches for one business, set by Bizora operations with a reason. A business with no row uses the product default.
-- Payment gateways and advanced accounting are not built, so they cannot be switched on.
CREATE TABLE IF NOT EXISTS business_features (
  tenant_id uuid NOT NULL REFERENCES organizations (id),
  feature varchar(32) NOT NULL,
  enabled boolean NOT NULL,
  reason varchar(500) NOT NULL,
  changed_by_staff_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, feature),
  CONSTRAINT business_features_feature_ck CHECK (feature IN ('offline_voice', 'photo_reads', 'support_view', 'advanced_accounting', 'payment_gateways')),
  CONSTRAINT business_features_locked_ck CHECK (NOT (enabled AND feature IN ('advanced_accounting', 'payment_gateways')))
);

-- Pilot measures: what happened, never who or what was said. No names, amounts, phone numbers or text from people.
-- `detail` is a short code (an operation type or a refusal code), never free text.
CREATE TABLE IF NOT EXISTS pilot_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organizations (id),
  event varchar(48) NOT NULL,
  detail varchar(48),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pilot_events_event_ck CHECK (event ~ '^[a-z][a-z0-9_.]{1,47}$'),
  CONSTRAINT pilot_events_detail_ck CHECK (detail IS NULL OR detail ~ '^[A-Za-z0-9_.:-]{1,48}$')
);
CREATE INDEX IF NOT EXISTS pilot_events_time_idx ON pilot_events (occurred_at, event);
CREATE INDEX IF NOT EXISTS pilot_events_tenant_idx ON pilot_events (tenant_id, occurred_at);

-- A sample business made for demonstrations and training. Shown as "Sample" everywhere and removable with a script.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS is_sample boolean NOT NULL DEFAULT false;

-- Removing a sample business (scripts/sample-business remove). Money, stock and return records stay unchangeable, as
-- before; the only exception is deleting a sample business's rows inside a transaction that set bizora.remove_sample.
CREATE OR REPLACE FUNCTION bizora_sample_removal(tenant uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('bizora.remove_sample', true), '') = 'on' AND EXISTS (SELECT 1 FROM organizations WHERE id = tenant AND is_sample) $$;

CREATE OR REPLACE FUNCTION bizora_journal_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP = 'DELETE' AND bizora_sample_removal(OLD.tenant_id) THEN RETURN OLD; END IF; RAISE EXCEPTION 'Journal entries cannot be changed or deleted. Post a reversing entry instead.' USING ERRCODE = '55000'; END $$;

CREATE OR REPLACE FUNCTION bizora_stock_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP = 'DELETE' AND bizora_sample_removal(OLD.tenant_id) THEN RETURN OLD; END IF; RAISE EXCEPTION 'Stock movements cannot be changed or deleted. Record a correction instead.' USING ERRCODE = '55000'; END $$;

CREATE OR REPLACE FUNCTION bizora_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP = 'DELETE' AND bizora_sample_removal(OLD.tenant_id) THEN RETURN OLD; END IF; RAISE EXCEPTION '% rows cannot be changed or deleted.', TG_TABLE_NAME USING ERRCODE = '55000'; END $$;
