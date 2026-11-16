# ADR-015: Quick sales, imports and the offline app

## Status

Accepted. Implements Spec Addendum v1.2 roadmap Sprint 5a. Builds on ADR-011 (roles), ADR-012 (offline), ADR-013 (ledger) and ADR-014 (stock). Sprint 5b adds the desk flow (ADR-016). Sprint 5c adds AI capture (photos, handwriting, scans and voice) into the same review screen.

## Decision

### Sales

- `sales`, `sale_lines` and `sale_payments` (migration 0016) belong to a business and a shop. Every foreign key includes `tenant_id`.
- A sale is **completed** or **voided**. Nothing is ever deleted. Database checks keep the amounts consistent: total = subtotal − discount, and paid + still owing = total.
- **One transaction per sale** (`SaleService.create`):
  1. The client sends a UUIDv7. Sending it again returns the same sale. The same ID from another organization is refused (`ID_CONFLICT`).
  2. Each line is priced from the product: the base unit price, the pack price, or the base price × pack size. Selling below that price, and a discount on the whole sale, need `sales.discount` (managers and owners).
  3. Payments are cash, transfer or POS, up to three at once (split). Paying more than the total is refused.
  4. Anything left owing is credit. Since ADR-016, credit needs a customer approved for credit, `sales.credit` or `debtors.manage`, a due date and a comment.
  5. It takes the next official receipt number (`R-000001`) from `DocumentNumberService`.
  6. For products whose stock is counted, it takes stock out with `StockService.applyMovement({ type: "sold" })`, which posts Dr cost of goods / Cr stock at the weighted average cost.
  7. It posts the sale: Dr cash for the shop, bank (transfer), POS clearing, and debtors for anything owing, plus Dr discounts. Cr sales (Cr service income for service businesses).
- **Cancelling** (`sales.void`, managers and owners) needs a reason. It reverses the sale's ledger entry and returns stock at the cost it left with (movement `returned`, reason `sale_void`, posting Dr stock / Cr cost of goods). The sale stays, marked cancelled.
- **Who sees what:** without `sales.read.all`, staff see only their own sales. Shop staff see only their shop. Line cost is shown only with `prices.cost.read`.
- **Receipts:** each sale has a random `receipt_token`. `/r/{token}` shows the receipt without signing in: shop name, lines, totals and payments, and nothing else (no cost, phone number or IDs). The sale screen builds a WhatsApp link. It opens the customer's chat only for staff who may see customer contacts (`customers.read`); otherwise it opens WhatsApp's share sheet.

### Offline sales

- The quick sale screen works from the product copy on the phone (ADR-014). With no network, the sale goes into the outbox as `sale.create`, with a number from the phone such as `DEV417-000045` and the time it was made.
- When it syncs, the server checks it exactly as it checks an online sale, as the person who made it. It keeps the phone's number and gives it an official one. Receipts show both.
- A sale made more than 7 days ago, or more than 5 minutes in the future, is refused. The phone shows why.
- Stock can go below zero when phones sell offline at the same time. That is allowed and shown under Stock, as in ADR-014.

### The offline app shell

- `public/sw.js` keeps built files (`/_next/static`, icons) once they load. Their names change with every release.
- It keeps a copy of five screens: `/app`, `/app/sales/new`, `/app/stock`, `/app/customers/new` and `/shop`. It always tries the network first and uses the copy only when there is none. Opening a saved screen also stores the files it needs.
- API responses are never cached.
- Saved screens contain the signed-in person's name and menu, so they are deleted when someone signs out, when a shop phone locks (the PIN screen deletes them), and when Shop mode is turned off. The shop PIN screen is kept because it shows nothing personal.

### Imports: check and edit before saving

- One shared screen (`components/import-review.tsx`) is used for products and sales:
  - The CSV file is read on the phone and matched to fields by common column names ("Item Name", "Qty", "Selling Price", "Paid by", and so on).
  - Rows appear in an editable table.
  - **Check rows** sends them as a dry run. The server returns a result for every row: new, update, or what to fix and in which column.
  - **Save** is enabled only after a check with no errors on exactly the rows shown. The server checks everything again and saves all rows or none.
- Limits: 2,000 rows and 1.5 MB per request.
- **Products** (`products.manage`): new products are created with their opening stock (cost × quantity, if the person may see costs). Products that already exist (by name) get their prices and details updated. Their stock does not change: stock changes go through stock in and counts, so they stay in the ledger with a reason.
- **Sales** (`sales.create`): rows with the same receipt number become one sale. The person picks how they count:
  - **Today's count, older ones are history** (default): today's rows go through `SaleService.create` and change stock and the accounts. Older rows are saved as history only (no number, no stock, no ledger), because current stock and cash already include them.
  - **Count them all:** only for sales from the last 7 days.
  - **History only:** records for reports.
  Counted rows must name an existing product and follow the same discount and credit rules as the sale screen. History rows may name products that are not in Bizora.
- Sprint 5c will fill the same table from photos of sales books, scanned records and voice notes (Vertex AI in the organization's Google Cloud project). They will be marked as drafts, with audit `actorType` `ai_draft`, and nothing will be saved until a person checks and saves them.

## Consequences

- Sales, stock and the ledger always agree: one transaction writes all three. The trial balance test covers cash, transfer, POS, split and credit sales, cancelling, and imports.
- Discounts have no amount limits yet. Only people with `sales.discount` can give one. Limits per role and owner approval come with the discounts report in Sprint 7.
- History-only sales are excluded from today's totals, stock and the ledger. Reports in Sprint 8.5 can include them as past figures.
- Offline numbers are random per phone, not unique across phones. The official number is unique.
