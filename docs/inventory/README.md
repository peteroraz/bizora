# Inventory

How stock is kept. Decisions:
- ADR-014: products, stock, movements and average cost;
- ADR-030: returns;
- ADR-034: approvals;
- ADR-046: catalog items over products.

Phase by phase: `GAP_ANALYSIS.md`.

## How stock is kept

- **Per shop.** Stock is kept per product and per shop (`stock_balances`), never as one global number.
- **Movements.** Every change is a movement (`stock_movements`): opening, received, sold, returned, adjusted, counted, transfer out and in, supplier return, and used or returned on a job.
  - Movements cannot be changed or deleted; a correction is a new movement.
  - All of them go through `StockService.applyMovement()`. It locks the balance, values the movement at weighted-average cost, posts the ledger entry (`stock:<movement id>`, so a retry never posts twice), writes the movement and updates the balance, in one transaction.
- **Below zero.** Stock cannot go below zero by a live action. A sale made offline or imported may take it below zero; that is flagged, not hidden.
- **Approvals.** Business rules can make receiving, adjusting, transferring and supplier returns wait for a manager (ADR-034). Counts wait for approval.

## Precision

- Quantities are bigint thousandths of the base unit: 2.5 kg is `2500`.
- Money is bigint minor units: ₦1,500.00 is `150000`.
- No floating point is used anywhere in stock or money.
