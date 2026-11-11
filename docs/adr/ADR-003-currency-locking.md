# ADR-003: Base-currency locking

## Status

Accepted for Sprint 2.5.

## Context

Each business has one ISO 4217 `base_currency_code`. Money is stored as bigint minor units. Once sales, invoices, or payments exist, rewriting that code would silently mis-scale historical amounts.

Sprint 2.5 has no financial tables yet.

## Decision

- `FinancialLedgerPort.hasPostedTransactions(tenantId, businessId)` is the only check onboarding/business-settings use before a base-currency change.
- `EmptyFinancialLedger` always returns `false`.
- Sales, invoices, and payments **must** implement the port against posted documents/ledger rows.
- Historical transaction currency codes are immutable. Changing base currency never rewrites past rows.
- Default policy: block the change (`CURRENCY_LOCKED`) once any posted transaction exists. A future admin-only conversion job would be a separate ADR.

## TODO for financial modules

- Implement `FinancialLedgerPort` in the sales/payments module.
- Count posted invoices, payments, or journal lines, not drafts.
- Keep original `currency_code` on every money row; never backfill from the business base currency.
