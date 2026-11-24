# ADR-051: Always show the books' profit

## Status

Accepted on 24 Nov 2026. Builds on ADR-038 (profit comes from sales) and ADR-049 (a cost estimate does not change the books).

## Context

The profit screen hid its figure whenever any goods were sold without a cost. One typed item, or a food shop that records ingredients as expenses, left the owner with "Add costs to calculate profit" and no number. A field called `knownProfitMinor` also took those sales out of the figure, which read as if the money had not come in.

## Decision

- The figure is always the books' profit: sales, less the cost that was recorded, less expenses. The home summary and the month view use that same figure.
- When some goods have no cost, a note under the figure says how much of sales that is, and that the figure is right if those purchases are already in expenses. Otherwise the real profit is lower. The note links to where a cost or an estimate can be added.
- When the owner has entered a cost estimate, "With your cost estimates" is a second line. It never replaces the books' figure. An estimate still does not change the journals.
- `knownProfitMinor` is removed. `profitStatus`, `uncostedSalesMinor`, `costCoverageBps` and `estimatedProfitMinor` stay.

## Consequences

- A shop that has not entered costs still sees what the books say.
- Typing an item that is not a product still just works.
