# Roles and permissions

Every permission is checked on the server, on every request, from the `role_permissions` table. The JWT role is never used for authorization. Anything not granted is refused (deny by default). See `docs/security/tenancy.md` and `docs/adr/ADR-011-job-function-access.md`.

The source of truth is `ROLE_PERMISSIONS` in `packages/contracts/src/access.ts`. Migration `0013_job_function_access.sql` stores the same grants, and `apps/api/src/job-function-access.test.ts` fails if the two ever differ. The tables below are generated from that file.

## Roles

| Role | Shown as | Signs in with | Job |
| --- | --- | --- | --- |
| OWNER | Owner | Email or Google | Owns the business. Everything. |
| ADMINISTRATOR | Administrator | Email or Google | Runs the business for the owner. Everything. |
| MANAGER | Manager | Email or Google | Runs a shop day to day: sales, cancellations, stock corrections, debtors, cash, staff and devices. |
| ACCOUNTANT | Accountant | Email or Google | Reads the figures and records expenses. Takes no sales or payments. |
| AUDITOR | Auditor | Email or Google | Reads everything, including the activity log. Changes nothing. |
| SALES | Sales staff | Email, or PIN on a shop device | Serves customers, records sales, follows up their own customers. |
| CASHIER | Cashier | Email, or PIN on a shop device | Takes payments, including debt repayments, and closes the cash drawer. |
| INVENTORY | Storekeeper | Email, or PIN on a shop device | Receives, counts and moves stock. |
| EMPLOYEE | Employee | Email, or PIN on a shop device | Basic access only. |

Only SALES, CASHIER, INVENTORY and EMPLOYEE can be created as PIN staff.

## What each role sees

| Role | Menu | Home cards | Customers |
| --- | --- | --- | --- |
| Owner, Administrator | Everything | Today's sales, money in vs out, cash at hand, top debtors, low stock, staff activity, needs approval, follow-ups, setup checklist | Full list |
| Manager | Everything | The same, without the setup checklist | Full list |
| Accountant | Home, Sales, Stock, Customers, Debtors, Money, Reports, Settings | Today's sales, money, cash at hand, debtors, low stock, follow-ups | Full list, read only |
| Auditor | Like the accountant | Like the accountant | Full list, read only |
| Sales staff | Home, Sales, Stock, Customers, Settings | My sales today, low stock, my follow-ups | Full list; own follow-ups only |
| Cashier | Home, Sales, Stock, Customers, Debtors, Settings | My sales today, top debtors, low stock, find a customer | Counter lookup only |
| Storekeeper | Home, Stock, Reports (stock), Settings | Low stock | None |
| Employee | Home, Settings | "Nothing to show yet" | None |

On the Stock screens, everyone with `stock.read` sees quantities and selling prices. Costs and stock values appear only with `prices.cost.read`. A storekeeper records stock in as owed to the supplier (paying from cash or bank needs `purchases.manage`), and their counts wait for a manager's approval (ADR-014).

Settings tabs follow the permissions too (`apps/web/src/lib/access.ts`). PIN staff see only Settings → Look.

## Data scope

Permissions decide what a person can do. Scope decides which rows and fields they get back.

- **Shop:** a branch-scoped membership only sees its own shop's customers, follow-ups and staff.
- **Counter lookup (`customers.lookup`, cashier):** there is no list. A search needs at least 3 letters of a name or 7 digits of a phone number, and returns at most 10 customers. Each result has the name, a walk-in flag and the last 4 digits of the phone. Email, address, tags, notes and follow-ups are never sent. This follows data minimisation in the Nigeria Data Protection Act 2023, s.24(1)(c).
- **Own follow-ups (`followups.read.all` missing, sales staff):** follow-ups assigned to that person or created by them. This applies to the list, the customer page, the Home card and updates (anything else is 404).
- **Setup checklist:** only for `business.settings.manage`.

## Separation of duties

| Duty | Done by | Checked or approved by |
| --- | --- | --- |
| Take money (`payments.record`, `cash.close`) | Cashier | Manager sees the expected cash (`cash.expected.read`) and cancels sales (`sales.void`). The cashier counts the drawer without seeing the expected amount. |
| Receive and count stock (`stock.receive`, `stock.count`) | Storekeeper | Manager corrects stock (`stock.adjust`) and orders from suppliers (`purchases.manage`). |
| Record an expense (`expenses.record`) | Accountant, Manager | Owner or Administrator approves (`expenses.approve`). |
| Check the books (`money.read`, `reports.*`) | Accountant, Auditor | They take no sales and no payments. |
| Download the customer list (`customers.export`) | Owner, Administrator | — |
| Desk flow: record a sale (`sales.create`) | Sales person | Cannot take money. May cancel their own sale only while it waits for payment. |
| Desk flow: take money or give credit (`sales.collect`, `sales.credit`) | Cashier | Credit only for customers a manager or owner approved (`debtors.manage`), within their limit, with a due date and comment. Cannot give out goods. |
| Desk flow: give out goods (`sales.release`) | Storekeeper | Only for sales the cashier finished. Sees the items, not amounts or the customer. |

## Permission matrix

Permissions under Sales, Debtors, Stock, Money and Reports are reserved: the modules that use them are not built yet. They are granted now so each module checks them from its first release.

### Setup and people

| Permission | Owner | Admin | Manager | Accountant | Auditor | Sales | Cashier | Storekeeper | Employee |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `tenant.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `branches.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `org.settings.manage` | ✓ | ✓ |  |  |  |  |  |  |  |
| `business.settings.manage` | ✓ | ✓ |  |  |  |  |  |  |  |
| `branch.settings.manage` | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| `branches.manage` | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| `branding.manage` | ✓ | ✓ |  |  |  |  |  |  |  |
| `tenant.manage` | ✓ | ✓ |  |  |  |  |  |  |  |
| `onboarding.complete` | ✓ | ✓ |  |  |  |  |  |  |  |
| `users.read` | ✓ | ✓ | ✓ |  | ✓ |  |  |  |  |
| `users.invite` | ✓ | ✓ |  |  |  |  |  |  |  |
| `users.manage` | ✓ | ✓ |  |  |  |  |  |  |  |
| `staff.manage` | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| `devices.manage` | ✓ | ✓ | ✓ |  |  |  |  |  |  |

### Customers

| Permission | Owner | Admin | Manager | Accountant | Auditor | Sales | Cashier | Storekeeper | Employee |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `customers.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |
| `customers.lookup` |  |  |  |  |  |  | ✓ |  |  |
| `customers.manage` | ✓ | ✓ | ✓ |  |  | ✓ |  |  |  |
| `customers.export` | ✓ | ✓ |  |  |  |  |  |  |  |
| `followups.manage` | ✓ | ✓ | ✓ |  |  | ✓ |  |  |  |
| `followups.read.all` | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |  |

### Sales and cash

| Permission | Owner | Admin | Manager | Accountant | Auditor | Sales | Cashier | Storekeeper | Employee |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `sales.create` | ✓ | ✓ | ✓ |  |  | ✓ | ✓ |  |  |
| `sales.read.own` |  |  |  |  |  | ✓ | ✓ |  |  |
| `sales.read.all` | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |  |
| `sales.discount` | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| `sales.void` | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| `sales.collect` | ✓ | ✓ | ✓ |  |  |  | ✓ |  |  |
| `sales.release` | ✓ | ✓ | ✓ |  |  |  |  | ✓ |  |
| `sales.credit` | ✓ | ✓ | ✓ |  |  |  | ✓ |  |  |
| `payments.record` | ✓ | ✓ | ✓ |  |  |  | ✓ |  |  |
| `cash.close` | ✓ | ✓ | ✓ |  |  |  | ✓ |  |  |
| `cash.expected.read` | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |  |

### Debtors

| Permission | Owner | Admin | Manager | Accountant | Auditor | Sales | Cashier | Storekeeper | Employee |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `debtors.read` | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ |  |  |
| `debtors.manage` | ✓ | ✓ | ✓ |  |  |  |  |  |  |

### Stock and products

| Permission | Owner | Admin | Manager | Accountant | Auditor | Sales | Cashier | Storekeeper | Employee |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `stock.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| `stock.receive` | ✓ | ✓ | ✓ |  |  |  |  | ✓ |  |
| `stock.count` | ✓ | ✓ | ✓ |  |  |  |  | ✓ |  |
| `stock.transfer` | ✓ | ✓ | ✓ |  |  |  |  | ✓ |  |
| `stock.adjust` | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| `products.manage` | ✓ | ✓ | ✓ |  |  |  |  |  |  |
| `prices.cost.read` | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |  |
| `purchases.manage` | ✓ | ✓ | ✓ |  |  |  |  |  |  |

### Money

| Permission | Owner | Admin | Manager | Accountant | Auditor | Sales | Cashier | Storekeeper | Employee |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `money.read` | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |  |
| `expenses.record` | ✓ | ✓ | ✓ | ✓ |  |  |  |  |  |
| `expenses.approve` | ✓ | ✓ |  |  |  |  |  |  |  |

### Reports and oversight

| Permission | Owner | Admin | Manager | Accountant | Auditor | Sales | Cashier | Storekeeper | Employee |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `reports.sales.read` | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |  |
| `reports.stock.read` | ✓ | ✓ | ✓ | ✓ | ✓ |  |  | ✓ |  |
| `reports.profit.read` | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |  |
| `audit.read` | ✓ | ✓ |  |  | ✓ |  |  |  |  |

## PIN staff limits

A session from a PIN login is bound to its shop device and cannot:

- switch workspace or create an organization,
- set a password or link Google,
- manage staff or devices, even if a later role change would allow it.

See `docs/adr/ADR-010-staff-pin-devices-and-plans.md`.
