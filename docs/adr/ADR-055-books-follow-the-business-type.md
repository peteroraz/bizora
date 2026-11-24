# ADR-055: The books follow the business type

## Status

Accepted on 24 Nov 2026. Builds on ADR-013 (chart of accounts) and ADR-035 (jobs).

## Context

A shop that later becomes a service business, or a chart made before Service income was added, can have no account with the role `service_income`. Saving a job or a sale then failed with `No account matches {"role":"service_income"}`. The chart filler only added an account when its code was free. The services template puts service income on `4000`, which a shop already uses for sales, so nothing was added. The same gap the other way left a service business with no `sales` account after it became a shop.

## Decision

- After the usual missing codes are added, every role in the business's template has an account, except cash, which stays one account per shop. Expense categories still share the expense role.
- A missing role is added from the template. If that code already belongs to another role, the next free code in the same thousand is used. Service income prefers `4050`, then `4051`. The name stays "Service income".
- An existing account keeps its code, name, role and entries. Nothing is renamed, re-roled, deleted or moved.
- Changing the business type in Settings fills the chart in that same request.
- A posting that still cannot find one account, or finds more than one, tells the trader: "Bizora could not save this to your books. Try again, and if it keeps happening, contact support with this code: " and the first 8 characters of the correlation id. The account lookup stays in the server log.

## Consequences

- The next job or sale in a business that is already the wrong shape adds the missing account. No one has to edit that business by hand.
- Two accounts never share a role, except cash per shop and the expense categories, which are chosen by code.
