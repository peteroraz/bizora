# ADR-014: Products, stock and the JavaScript budget

## Status

Accepted. Implements Spec Addendum v1.2 roadmap Sprint 4, the stock parts of §5 (who, where, when, approvals) and §7 (offline), and the §8 budgets. Builds on ADR-011 (roles), ADR-012 (offline) and ADR-013 (ledger).

## Decision

### Products

- `products` belong to a business:
  - a base unit, which is how stock is counted (piece, tin, bag, kg, litre, …);
  - an optional selling price per base unit and an optional default cost;
  - a low-stock level, a barcode and whether stock is counted at all.
- Names are unique per business, case-insensitive, among active products. Removing a product archives it, and its history is kept.
- **Pack sizes** (`product_units`): for example, 1 carton = 48 tins. Each pack can have its own price. Stock can be recorded in any of a product's units, and the server converts to the base unit.
- **Quantities** are whole thousandths of the base unit (2.5 kg = 2500) everywhere: database, API and calculations. They travel as decimal strings ("2.5"). Money travels as strings of kobo. No floating point is used.
- **Displays** use the biggest packs first: 136 tins with cartons of 48 shows as "2 cartons, 40 tins".
- **Cost is visible only with `prices.cost.read`:** the default cost, stock value and the value of each movement. Everyone with `stock.read` sees quantities and selling prices. Without cost permission, a person cannot set a cost, and editing a product keeps the existing cost.

### Stock: an append-only ledger

- `stock_movements` records every change: opening, received, sold (Sprint 5), returned, adjusted, counted, transfer out and transfer in.
  - Each row stores the signed quantity, its cost value, what was typed (quantity and unit), the reason, supplier and note.
  - It also stores who (user, membership, `actor_type` such as STAFF_PIN), where (shop and device) and when (on the device and on the server).
  - A database trigger refuses edits and deletes.
- `stock_balances` holds quantity and cost value per product per shop. It is updated in the same transaction as each movement, after locking the row, so concurrent changes are counted correctly.
- **One way in:** `StockService.applyMovement()`. It locks the balance, values the movement, posts the accounting entry, writes the movement and updates the balance. Sales (Sprint 5) will use it too.

### Costing: weighted average per product per shop (ADR-013)

- **Goods in** are valued at the cost entered. If no cost is entered, the current average is used, or the product's default cost, or zero.
- **Goods out** remove value in proportion to quantity, and the last unit takes whatever value is left (`@bizora/money` `issueStock`).
- **Transfers:** the receiving shop takes exactly the value that left the sending shop.
- **Negative stock** after a sync is allowed. The balance gets `negative_since`, and owners and managers see it under "Below zero, please check". It is never corrected automatically, and the flag clears when stock is back at zero or above.

### Accounting entries (through `LedgerPostingService`)

| Movement | Debit | Credit |
| --- | --- | --- |
| Opening stock (when adding a product) | Stock | Owner's money put in |
| Stock in, paid from shop cash | Stock | Cash at that shop |
| Stock in, paid by bank or transfer | Stock | Bank accounts |
| Stock in, owed to supplier | Stock | Suppliers we owe |
| Removed: damaged, expired, missing, other | Stock lost or damaged | Stock |
| Removed: taken for own use | Owner's withdrawals | Stock |
| Removed: given away | Other expenses (6900) | Stock |
| Added: found, correction, count over | Stock | Stock lost or damaged |
| Count short | Stock lost or damaged | Stock |
| Transfer between shops | none (one stock account per business) | |

Movements with zero value post nothing. Each posting key is `stock:<movement id>`, so retries never post twice.

### Who can do what (ADR-011 permissions)

- `stock.read`: products, quantities, selling prices, history, low stock.
- `products.manage`: add, edit and remove products.
- `stock.receive`: record stock in. Recording payment from cash or bank needs `purchases.manage`. Otherwise it is recorded as owed to the supplier, so a storekeeper never records paying out money.
- `stock.adjust`: remove or correct stock, approve or reject counts, see below-zero products.
- `stock.transfer`: move stock to another shop of the same business. `GET /stock/shops` lists the names of all shops, so a shop-scoped storekeeper can choose where to send stock.
- `stock.count`: count stock.
  - A count by someone with `stock.adjust` is applied at once.
  - Anyone else's count waits for approval. It shows on the Stock screen and in "Needs approval" on Home.
  - When approved, the difference found at counting time is applied, even if sales happened since.

### Offline (ADR-012)

- `stock.receive` and `stock.count` are sync operations, with the movement or count ID made on the device. A retry returns the same result.
- `GET /api/v1/products/sync` downloads products (archived ones included, so the phone can drop them) and this shop's quantities changed since two cursors, 500 rows a page. It contains no cost fields for people without `prices.cost.read`.
- The phone keeps this in IndexedDB (`cache` store, `lib/offline/catalog.ts`) and refreshes it when the app opens and when the network returns. The Stock screen falls back to it, with "No network. Showing stock saved on this phone (time)."
- Not built yet: opening the app from scratch with no network. The service worker does not cache pages. Offline works when the app is open and the signal drops. An offline app shell that is safe on shared phones comes with Sprint 5 (sales must work offline).

### JavaScript and loading budgets (Spec §8, enforced in CI)

- `apps/web/e2e/performance-budget.e2e.ts` loads each core screen (login, PIN screen, Home, Customers, Stock) in a fresh browser at 360 px wide. Chrome is set to Lighthouse "Slow 4G" (1.6 Mbps, 150 ms) with the CPU slowed 4x.
- The test sums the compressed JavaScript that loads before the page's load event and fails if any screen is over 170 KB or has a Largest Contentful Paint over 2.5 s.
- At the end of this sprint:

| Screen | JavaScript | LCP |
| --- | --- | --- |
| Login | 131 KB | 0.6 s |
| PIN screen | 130 KB | 2.1 s |
| Home | 143 KB | 0.8 s |
| Customers | 145 KB | 0.8 s |
| Stock | 146 KB | 0.6 s |

Before the changes below, the app screens were 233–250 KB:
- `experimental.optimizePackageImports` for `@bizora/ui`, `@bizora/contracts` and `@bizora/money`. A server layout importing the UI barrel had pulled every client component into every page.
- `"sideEffects": false` on the shared packages. The contracts entry is now re-exports only: its own schemas moved to `identity.ts`, and constants to `constants.ts`. Importing `Permission` no longer brings the phone-number library (27 KB), the regions list (19 KB) or zod.
- Money formatting moved to `@bizora/money/format`, without decimal.js.
- The account menu and the slide-in menus load on first tap. The collapsed sidebar uses native tooltips.

## Consequences

- Sales (Sprint 5) issue stock with `applyMovement({ type: "sold" })` and post cost of goods sold with the sale.
- **Residual value:** if stock goes from below zero back to exactly zero, a small value can remain on the balance until the next movement. Sprint 5's cost of sales handles it.
- New pages must stay within the budget. The CI test names the screen and the size when one doesn't.
