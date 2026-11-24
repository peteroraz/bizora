-- ADR-053: a product-less line marked service was often goods typed at the counter.
-- Job bills, imported history, and sales that earned service income stay service.
UPDATE sale_lines AS sl
SET line_kind = 'quick'
FROM sales AS s
WHERE sl.tenant_id = s.tenant_id
  AND sl.sale_id = s.id
  AND sl.product_id IS NULL
  AND sl.line_kind = 'service'
  AND s.source <> 'job'
  AND s.source <> 'import'
  AND s.history_only = false
  AND s.journal_entry_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM journal_lines AS jl
    JOIN ledger_accounts AS a ON a.tenant_id = jl.tenant_id AND a.id = jl.account_id
    WHERE jl.tenant_id = s.tenant_id
      AND jl.entry_id = s.journal_entry_id
      AND a.role = 'service_income'
      AND jl.credit_minor > 0
  );
