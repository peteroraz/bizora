-- Sprint 7g (ADR-033): no plan limits for now (owner, 19 Nov). Every plan allows practically unlimited shops, staff and
-- shop phones, with every feature on. AI photo and voice reads are counted per shop: 100 a shop a day.
-- The plan rows stay, so limits can come back later from the Admin portal.
UPDATE plans
SET limits = '{"max_branches": 1000, "max_staff": 10000, "max_devices": 1000, "ai_daily_reads": 100, "features": {"multi_currency": true, "whatsapp_automation": true, "advanced_reports": true, "ai": true, "integrations": true}}'::jsonb
WHERE code IN ('starter', 'business');

-- AI usage per shop and day. Reads counted before this migration stay under an all-zero shop id.
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS branch_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';
ALTER TABLE ai_usage DROP CONSTRAINT IF EXISTS ai_usage_pkey;
ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_pkey PRIMARY KEY (tenant_id, branch_id, day);
ALTER TABLE ai_usage ALTER COLUMN branch_id DROP DEFAULT;
