# ADR-032: Default shops, closing shops, and reasons in the stock history

## Status

Accepted on 18 Nov 2026 (Sprint 7f). From the owner's review of 18 Nov.

## Context

The owner asked for:

- **Default shops.** Every person (manager, cashier and so on) opens in a shop of their own. Someone allowed in every shop opened in "All shops" whenever a business had more than one.
- **Closing shops.** Only owners close a shop, or move it into another. There was no way to close a shop at all.
- **Reasons on stock.** Stock actions carry comments or reasons, and those show in the history and audit trail. Notes were possible on some actions only, and changes to prices, counts and products did not show in a product's history.
- **Smaller fixes:**
  - receipts and invoices printed coloured text, and left out the customer's address;
  - a receipt link said "Link copied" forever after one copy;
  - customers could not be edited, and the "More" menu never said "Less";
  - the Google button appeared some time after the sign-in page.

## Decision

### Default shop

`memberships.default_branch_id` is the shop Bizora opens in for someone allowed in more than one shop.

- **At sign-in, and when choosing a workspace,** that shop is selected. Choosing a business or "All shops" in the switcher still does what it says.
- **Someone tied to one shop** always opens there; another default is refused.
- **Who sets it** (`PUT /memberships/:id/default-shop`):
  - each person, for themselves, from the shop switcher ("Always open Bizora in this shop");
  - owners and administrators (`users.manage`), for anyone, in Settings → Team.
- **A closed shop** is never used as a default.

### Closing a shop

`POST /branches/:id/close` is the **owner's** alone, decided by role. Administrators and managers cannot close shops. Shop-phone sessions cannot either.

- **The check first.** `GET /branches/:id/closing` shows what is still in the shop: products in stock, cash in the drawer, staff who work only there, customers who belong there, and unfinished sales.
- **What blocks it:**
  - sales still waiting at the cashier or for goods to be given out;
  - products below zero;
  - closing the business's last open shop.
- **What moves to the shop the owner chooses:**
  - every product on hand, as a transfer at the value it holds;
  - the cash in the drawer: Dr cash (other shop) · Cr cash (closed shop);
  - staff who worked only there (they sign in again);
  - default shops that pointed at it;
  - its customers.

  When something is left, choosing a shop is required (`CHOOSE_SHOP`).
- **Shop phones** in the closed shop are stopped, and their sessions ended. Counts waiting there are rejected with the reason.
- **What a closed shop keeps:** its history (`closed_at`, `closed_by`, `closed_reason`, `moved_into_branch_id`).
- **Where a closed shop no longer appears:** shop lists, the shop switcher, cash in the shops, stock transfers and the plan's shop count.
- **New work there is refused** (`SHOP_CLOSED`).

### Reasons in the stock history

| Action | Reason |
|---|---|
| Stock in, moving stock to another shop, a count | Optional note box |
| Taking stock off or adding it by hand | Required ("What happened") |
| Rejecting a count | Required |
| Approving a count | Optional; added to the movement's note after the counter's note |
| Changing the selling price or cost | Required (`changeReason`); a product file import gives its own reason |
| Removing a product from the list | Optional |

- **The audit trail.** Every stock action's audit event now carries its note, reason and quantities. Product changes record what changed (old → new) and why.
- **The product's history.** `GET /products/:id/changes` lists product changes, removal and rejected counts, with who, when and why. The product page shows them in one history with the stock movements, newest first.
- **Cost changes** are hidden, with their reason, from people who may not see cost.

### Documents and links

- **Notices print in black.** "Paid in full…", "owed on credit…", "Not paid yet…" and "CANCELLED…" no longer use green, amber or red, which fade on shop printers and photocopies. The business's own brand colour stays on its name and the title.
- **The customer's address** is printed under their name on invoices and receipts, and shown on the receipt link.
- **Copying a link** works as often as needed. The button says "Link copied" for two seconds, then goes back. Where the phone blocks the clipboard, a hidden text box is used, and failing that the button says so.

### Customers

- **Editing.** A customer's page has "Edit details": name, phone (shown the way it is typed), email, tags, notes and address. Credit stays in its own panel.
- **"More" says "Less"** while it is open. The new-customer form's extra-details link can be closed again.

### Google sign-in

The sign-in, register and invite pages read which sign-in options are on from the server, with the page, kept for five minutes. Before, the browser asked the API after the page had started. The button now arrives with the page and says "Opening Google…" when tapped. If the server cannot be asked, the browser asks as before.

## Consequences

- **Moving stock into another shop.** A shop with products below zero must be counted first.
- **Open debts recorded in the closed shop** stay on those sales (owners see them everywhere). Their customers move to the new shop.
- **A closed shop cannot be reopened.** That can come later if needed.
- **Free plans allow one shop,** so closing a shop is tested in the API tests, not on screen.
- **The time to Google's own page** still depends on the API answering the start link. A cold API on Cloud Run adds a moment there; keeping one instance warm would remove it.
