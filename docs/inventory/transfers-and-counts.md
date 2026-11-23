# Inventory: warehouses, transfers and counts

How stock is kept. Decisions:
- ADR-014: movements and average cost;
- ADR-030: returns;
- ADR-034: approvals;
- ADR-047: warehouses, transfers, count sessions.

## How stock is kept

- **Per place.** Stock is kept per product and per place (`stock_balances`): shops and warehouses. There is never one global number.
- **Movements.** Every change is a movement (`stock_movements`), which cannot be changed or deleted. All of them go through `StockService.applyMovement()`. It locks the balance, values the movement at weighted-average cost, posts the ledger entry (once per movement), writes the movement and updates the balance, in one transaction.
- **Warehouses.** A warehouse keeps stock but does not sell at the counter.
- **Transfers.** Requested, then approved, dispatched (stock is on the way) and received (stock arrives), or cancelled before dispatch. Less arriving than sent is recorded as missing.
- **Counts.** One product at a time (`/stock/counts`), or a session of many (`/inventory/counts`): counting, then submitted, then posted on approval.

## API (ADR-047)

| Route | Who |
| --- | --- |
| `GET /api/v1/inventory/transfers?status=`, `GET …/:id` | `stock.read` |
| `POST /api/v1/inventory/transfers` (`dispatchNow` to send at once) | `stock.transfer` |
| `POST …/transfers/:id/approve` | `stock.adjust` |
| `POST …/transfers/:id/dispatch` | `stock.transfer`, at the sender |
| `POST …/transfers/:id/receive` (`lines[].receivedQuantity`) | `stock.transfer` or `stock.receive`, at the receiver |
| `POST …/transfers/:id/cancel` (`reason`) | the asker, or `stock.adjust` |
| `GET/POST /api/v1/inventory/counts`, `GET …/:id` | read `stock.read`, start `stock.count` |
| `POST …/counts/:id/lines`, `DELETE …/counts/:id/lines/:productId`, `POST …/counts/:id/submit` | `stock.count` |
| `POST …/counts/:id/approve` (posts), `POST …/counts/:id/reject` (`note`) | `stock.adjust` |
| `POST …/counts/:id/cancel` | the starter, or `stock.adjust` |

## Precision

- Quantities are bigint thousandths of the base unit: 2.5 kg is `2500`.
- Money is bigint minor units: ₦1,500.00 is `150000`.
- No floating point is used anywhere in stock or money.
