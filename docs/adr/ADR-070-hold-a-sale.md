# ADR-070: Hold a sale on the phone

## Status

Accepted on 25 Nov 2026. From the product direction brief, section 1A ("Hold / Park Sale"), and the design proposal of the same date.

## Context

A customer brings goods to the counter, then says "Let me get cash from the ATM". Until now the cashier had to cancel the cart or keep the customer blocking the screen.

## Decision

### Held sales live only on the phone

- A held sale is the cart put aside under a name: items, quantities, units, typed prices, customer, discount, payment choice, split amounts, note, due date, comment and price list.
- It is kept in the phone's offline store (`cache`, key `held-sales:{organization}:{membership}:{shop}`), per person and per shop.
- **It never reaches the server.** It has no number, posts nothing to the books, moves no stock, creates no debt and gets no receipt. It does not count in any total or report.
- A server-side status was considered and rejected. It would be one more status that every report, stock figure and sync rule has to remember to ignore. A cart that waits a few minutes does not need it.
- Signing out of Shop mode clears the offline store, and held sales with it, as the privacy notice says for other data kept on the phone. A held cart can hold a customer's name.
- At most 20 held sales per person and shop. A 21st is refused with a message, rather than dropping the oldest unseen.

### The screen

- **Hold** sits beside **Record sale** at the bottom once the cart has an item. It asks "Who is it for?", filled in with the chosen customer's name, and saves. The screen is then empty for the next customer, with "{name} is held. Serve the next customer."
- **Held sales (2)** shows at the top of the quick sale only while something is held. The list shows each name, item count, total and time held.
- **Resume** brings the cart back as it was. It is disabled while another cart is on screen, so a held sale never overwrites one in progress.
- **Product prices come from today's list** when a sale is resumed, and the server checks prices again when it is recorded. Typed items keep the price that was typed.
- A resumed sale leaves the list only when it is recorded (online, or saved offline to send later). Holding it again keeps its place under the same id, so a cart is never lost between resume and record.
- **Delete** asks once more on the same button ("Yes, delete").
- A sale held a day or more ago shows the time with the weekday, and the screen says some were held yesterday or earlier, so they are resumed or deleted rather than forgotten. They are not deleted automatically.

### What it does not do

- It does not reserve stock. Another customer can buy the last bag while a sale is held; the usual shortage warning shows when it is resumed. Reservation belongs to confirmed orders.
- It does not move between phones. A shop that wants to start on one phone and finish on another needs orders, which are not built yet.

### Size

The held list loads after the screen has opened, and the panel loads when first used (and is fetched for offline use after the screen loads). The quick sale stays within its 170 KB script budget.

## Consequences

- No server, database or sync change.
- Tests: `apps/web/e2e/hold-sale.e2e.ts` covers holding, nothing being recorded, surviving a reload, no resume over a cart in progress, resume and record, leaving the list once recorded, and deleting with a second tap.
