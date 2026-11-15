# Roles and permissions

Permissions are stored in `role_permissions` and loaded from the database on every request. The JWT role is never used for authorization. See `docs/security/tenancy.md`.

## Roles

| Role | Shown as | Signs in with | Typical use |
| --- | --- | --- | --- |
| OWNER | Owner | Email or Google | Owns the organization. Everything. |
| ADMINISTRATOR | Administrator | Email or Google | Runs the organization for the owner. |
| MANAGER | Manager | Email or Google | Runs a business or branch: staff, devices, customers. |
| ACCOUNTANT | Accountant | Email or Google | Reads figures, costs and profit. Changes nothing. |
| AUDITOR | Auditor | Email or Google | Reads everything an accountant reads, plus the user list. |
| SALES | Sales staff | Email, or PIN on a shop device | Serves customers and records sales. |
| CASHIER | Cashier | Email, or PIN on a shop device | Takes payments. |
| INVENTORY | Storekeeper | Email, or PIN on a shop device | Receives and counts stock (Sprint 4). |
| EMPLOYEE | Employee | Email, or PIN on a shop device | Basic access only. |

Only SALES, CASHIER, INVENTORY and EMPLOYEE can be created as PIN staff.

## Permission matrix

| Permission | OWNER | ADMIN | MANAGER | ACCOUNTANT | AUDITOR | SALES | CASHIER | INVENTORY | EMPLOYEE |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tenant.read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| branches.read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| customers.read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | |
| customers.manage | ✓ | ✓ | ✓ | | | ✓ | | | |
| followups.manage | ✓ | ✓ | ✓ | | | ✓ | | | |
| users.read | ✓ | ✓ | ✓ | | ✓ | | | | |
| users.invite | ✓ | ✓ | | | | | | | |
| users.manage | ✓ | ✓ | | | | | | | |
| staff.manage | ✓ | ✓ | ✓ | | | | | | |
| devices.manage | ✓ | ✓ | ✓ | | | | | | |
| prices.cost.read | ✓ | ✓ | ✓ | ✓ | ✓ | | | | |
| reports.profit.read | ✓ | ✓ | ✓ | ✓ | ✓ | | | | |
| branches.manage | ✓ | ✓ | ✓ | | | | | | |
| branch.settings.manage | ✓ | ✓ | ✓ | | | | | | |
| business.settings.manage | ✓ | ✓ | | | | | | | |
| org.settings.manage | ✓ | ✓ | | | | | | | |
| branding.manage | ✓ | ✓ | | | | | | | |
| tenant.manage | ✓ | ✓ | | | | | | | |
| onboarding.complete | ✓ | ✓ | | | | | | | |

The web app hides menu items, Settings tabs and buttons the role cannot use (`apps/web/src/lib/access.ts`). This is only for clarity: the API checks every request either way.

- PIN staff see only Settings → Look (theme and language). They have no email, password or Google sign-in to manage.
- Staff appears in the menu only with `staff.manage` or `devices.manage`. Customers needs `customers.read`, and adding, importing, noting or deleting customers needs `customers.manage`.
- Opening a page by its link without the permission shows "This page is not for your role".

Scope still applies on top of the matrix. A branch-scoped manager has `staff.manage` only for their own branch.

`prices.cost.read` and `reports.profit.read` are reserved. Products (Sprint 4) and profit reports will check them; nothing reads them yet.

## PIN staff limits

A session from a PIN login is bound to its shop device and cannot:

- switch workspace or create an organization,
- set a password or link Google,
- manage staff or devices, even if a later role change would allow it.

See `docs/adr/ADR-010-staff-pin-devices-and-plans.md`.
