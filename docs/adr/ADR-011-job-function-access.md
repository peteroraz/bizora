# ADR-011: Access by job function

## Status

Accepted. Extends ADR-010 and replaces the role grants from migrations 0001 to 0012 with the matrix in `packages/contracts/src/access.ts`.

## Context

Every role saw much the same screens. A cashier could browse every customer, with phone numbers, emails, addresses and notes. Sales staff saw every follow-up in the shop. The Home dashboard showed money, cash and debtor cards to everyone. Settings was fixed in PR #10, but the rest of the app was not.

Sales, Stock, Debtors and Money are next on the roadmap. Their permissions should exist before their code does, so no module ships with "everyone can see it" as a default.

## What we followed

- **OWASP Authorization Cheat Sheet and OWASP Top 10 A01:** deny by default, least privilege, check on the server for every request, log access decisions.
- **Separation of duties** from retail internal controls: the person holding an asset (cash, stock) is not the person who approves changes to it or records it. A second person approves voids. Cash is counted blind.
- **Nigeria Data Protection Act 2023, s.24(1)(c):** personal data limited to the minimum needed for the purpose.
- **How POS products split roles:** Square turns off customer directory access and "view all sales" for cashiers, has a separate permission for customer contact details, and shows the expected drawer amount only to managers. Lightspeed and Loyverse have separate permissions for cost prices and for seeing other people's receipts. Zoho hides cost and selling prices per role.

## Decision

### One matrix, three layers

1. **Permissions:** what a role may do. `ROLE_PERMISSIONS` in contracts is the single source. Migration 0013 stores exactly those grants, and a test fails if the database and the file differ.
2. **Scope:** which rows come back. Branch scope (already in place), own follow-ups for sales staff, and counter lookup for cashiers.
3. **Fields:** which columns come back. A counter lookup returns the name, a walk-in flag and the last 4 digits of the phone only.

The web app hides menu items, Home cards, Settings tabs and buttons using the same permissions. That is for clarity only; the API enforces everything.

### New permissions

- **Customers:** `customers.lookup`, `customers.export`, `followups.read.all`.
- **Reserved for modules not built yet:**
  - Sales and cash: `sales.create`, `sales.read.own`, `sales.read.all`, `sales.discount`, `sales.void`, `payments.record`, `cash.close`, `cash.expected.read`.
  - Debtors: `debtors.read`, `debtors.manage`.
  - Stock and products: `stock.read`, `stock.receive`, `stock.count`, `stock.transfer`, `stock.adjust`, `products.manage`, `purchases.manage`.
  - Money: `money.read`, `expenses.record`, `expenses.approve`.
  - Reports and oversight: `reports.sales.read`, `reports.stock.read`, `audit.read`.

### Role changes that take effect now

- **CASHIER** loses `customers.read` and gets `customers.lookup`.
  - Searches must be specific: at least 3 letters of a name, or 7 digits of a phone number. At most 10 results.
  - Notes, follow-ups, addresses and emails are refused.
  - When Sales and Debtors exist, the cashier's Customers screen will also list customers who owe money or paid recently. That list will come from `debtors.read` and `payments.record`, with the same limited fields.
- **SALES** sees only follow-ups assigned to them or created by them. Changing someone else's follow-up returns 404.
- **Home dashboard:** cards follow the job (see `docs/security/roles.md`). The setup checklist is only for people with `business.settings.manage`.
- **Module pages** (Sales, Stock, Debtors, Money, Reports): opening one without its permission shows "This page is not for your role".

## Consequences

- A role change is a migration that edits `ROLE_PERMISSIONS` and the grants together. The matrix test keeps them in step.
- A cashier who needs to browse customers must be given another role, such as Sales staff. We chose a fixed role per person over per-person toggles: shops are small, and fixed roles are easier to reason about. Custom roles can come later as a new ADR.
- The lookup's minimum search length slows enumeration but does not prevent it. The auth throttler applies only to sign-in, so a rate limit on lookup is a follow-up item.
- The Manager keeps `prices.cost.read` and `reports.profit.read`, as in ADR-010. An owner who wants margins hidden from managers needs custom roles, which are not available yet.
