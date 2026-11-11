-- Sessions are disposable. Rows whose business_id, branch_id, or membership_id
-- would violate the tenant-safe foreign keys below are deleted (or nulled)
-- before constraints are added. Do not treat session history as durable.

DELETE FROM sessions
WHERE business_id IS NOT NULL
  AND (
    tenant_id IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM businesses b
      WHERE b.id = sessions.business_id
        AND b.tenant_id = sessions.tenant_id
    )
  );

DELETE FROM sessions
WHERE branch_id IS NOT NULL
  AND (
    tenant_id IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM branches br
      WHERE br.id = sessions.branch_id
        AND br.tenant_id = sessions.tenant_id
    )
  );

DELETE FROM sessions
WHERE membership_id IS NOT NULL
  AND (
    tenant_id IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM memberships m
      WHERE m.id = sessions.membership_id
        AND m.tenant_id = sessions.tenant_id
    )
  );

UPDATE sessions
SET branch_id = NULL
WHERE branch_id IS NOT NULL
  AND business_id IS NULL;

ALTER TABLE memberships
  ADD CONSTRAINT memberships_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE sessions
  ADD CONSTRAINT sessions_tenant_business_fk
  FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id);

ALTER TABLE sessions
  ADD CONSTRAINT sessions_tenant_branch_fk
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id);

ALTER TABLE sessions
  ADD CONSTRAINT sessions_tenant_membership_fk
  FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships (tenant_id, id);

ALTER TABLE sessions
  ADD CONSTRAINT sessions_scope_ck CHECK (branch_id IS NULL OR business_id IS NOT NULL);
