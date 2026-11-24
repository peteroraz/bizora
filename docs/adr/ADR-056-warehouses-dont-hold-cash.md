# ADR-056: A warehouse does not hold cash

## Status

Accepted on 24 Nov 2026. Builds on ADR-028 (cash in each shop) and ADR-047 (warehouses). No migration. ADR-053, ADR-054 and ADR-055 are used by open pull requests, so this decision is 056.

## Context

Every branch, including a warehouse, was given a cash account. A delivery whose goods or charges were paid "cash" at a warehouse took that money out of the warehouse's cash. The Money screen then showed the warehouse drawer going negative. A warehouse is a store, not a till.

Some warehouses already have cash entries from before this decision. Those entries are history.

## Decision

- New cash accounts are created for shops only. `ChartOfAccountsService.ensure()` skips `kind = 'warehouse'`. An existing warehouse cash account is not renamed, re-roled, deleted, or moved.
- When stock is received at a warehouse and the goods or a charge are paid in cash, the request names `paidFromBranchId`: a shop in the same business, not a warehouse and not a closed shop. The posting credits that shop's cash. The stock still lands at the warehouse.
- A shop receiving its own stock can leave the shop unnamed. The cash comes out of that shop.
- Cash at a warehouse with no shop named is refused: "Choose which shop's cash paid this, or choose bank." Bank and owed-to-supplier need no shop.
- Cash counts, cash per shop and the cash screens list shops. A warehouse cash account with a zero balance and no journal lines is hidden. A warehouse that already has cash entries stays on the cash screen, with the note "This warehouse still has cash from before. Move it under Money › Move money." Those entries are not rewritten. A count of a warehouse drawer is refused.
- The shop is checked with the caller's tenant and business. Another business's shop is not found.

## Consequences

- A delivery paid from Singer market's cash reduces Singer market's drawer. The warehouse has no cash line for that delivery.
- Old warehouse cash stays visible until the owner moves it. Nothing in the past books changes.
- The next time a warehouse is used, no new cash account is created for it.
