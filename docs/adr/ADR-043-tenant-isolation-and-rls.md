# ADR-043: Tenant isolation for the pilot, and why row-level security waits

## Status

Accepted on 23 Nov 2026. Row-level security (RLS) is a **blocking item before general availability**, not before the controlled pilot.

## Context

PostgreSQL RLS was planned. Bizora now has 48 tenant-owned tables:

addresses, ai_usage, audit_events, branches, businesses, cash_counts, country_packs, customer_followups, customer_notes, customer_payments, customers, document_sequences, idempotency_keys, job_lines, jobs, journal_entries, journal_lines, ledger_accounts, ledger_periods, memberships, money_movements, notifications, organization_logos, payment_allocations, plans, product_photos, product_units, products, sale_comments, sale_lines, sale_payments, sale_return_lines, sale_returns, sales, saved_items, shop_devices, staff_credentials, staff_pin_attempts, statement_imports, statement_lines, statement_rules, stock_balances, stock_counts, stock_movements, stock_requests, supplier_entries, suppliers, work_permits.

These tables are reached by 48 services through one shared connection pool. RLS only protects when every query runs with the tenant set on its own connection (`SET LOCAL app.tenant_id` inside a transaction) and the app connects as a role that doesn't own the tables (or with `FORCE ROW LEVEL SECURITY`).

## Why not now

- **Every request would need a transaction.** All 48 services would have to take a request-scoped transaction instead of the shared pool, or a proxy would have to wrap every request in one. That changes how every financial write and every offline sync batch commits, just before real businesses use it.
- **Cross-tenant work would need a separate path.**
  - Public receipt pages find a sale by its token before the business is known.
  - The admin portal reads one business at a time for support.
  - Sign-in looks up memberships across organisations.

  Each needs a deliberate bypass role. Getting one wrong would either break the feature or open a hole.
- **Partial RLS would mislead.** RLS on a few tables while the app still connects as the table owner would be bypassed silently.

## Decision for the pilot

1. **Application-level isolation stays the control.**
   - The tenant comes only from the signed-in session, never from the client.
   - Every query filters by `tenant_id`; a record from another business is "not found".
2. **A blocking test matrix replaces RLS evidence** (`apps/api/src/tenant-matrix.test.ts`, run on every PR). Business A's owner, with every permission:
   - calls **every API route that takes an id** with business B's real ids (77 routes); each must answer 403 or 404 for reads, and refuse writes;
   - reads **every list route** and must see none of B's names or ids;
   - tries to **create** sales, stock moves, jobs, permits, invitations, expenses and cash-outs that point at B's records, plus an **offline sync** of a sale with B's product;
   - finishes with **every one of B's rows across all 48 tables unchanged**, checked by a fingerprint of the rows.

   A new route with an id fails the matrix until it is mapped, so no route goes untested.
3. **Existing tests stay:** `tenant-isolation.test.ts` (sessions, scope headers, tokens, switching) and per-feature isolation checks.
4. **Before general availability:** RLS with a non-owner app role, request-scoped transactions, and named bypass paths (public receipts, admin, sign-in). Tracked as a blocking GitHub issue.

## Findings when the matrix first ran

- `GET /customers/:id/followups` answered 200 with an empty list for another business's customer. Nothing leaked, but it didn't check ownership. It now returns 404 (fixed, covered by the matrix).
- Three probes stop at input validation before the ownership check: product photo upload, product edit and job line add. The row fingerprint shows they change nothing, and their services filter by tenant.
