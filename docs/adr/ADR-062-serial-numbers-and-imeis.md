# ADR-062: Serial numbers and IMEIs

## Status

Accepted on 24 Nov 2026. Inventory brief section 17. Migration `0050_serial_numbers.sql`.

Builds on:
- ADR-030 (returns);
- ADR-048 (deliveries);
- ADR-050 (offline sales are kept).

## Context

Phone, laptop and appliance sellers sell units, not quantities. They need three things:
- to know which IMEI is still on the shelf;
- to know who bought a given phone;
- to be sure the same phone is never sold twice.

Bizora counted stock per product only.

## Decision

**A switch on the product.** "Keep a serial number or IMEI for each unit" (`products.tracks_serials`) sits on the new product and edit forms, for stock that is counted. It is off by default.

**One row per unit.** `serial_numbers` holds:
- the product and the shop it is in (or was sold from);
- the serial as stored (no spaces, in capitals);
- its status: in stock, sold, returned, damaged, transferred or reserved;
- the sale, sale line and customer it went to.

A unique index on (business, product, serial) means one serial is one unit. `serial_number_events` keeps what happened to each unit, oldest first, and is never changed.

**The movements:**
- **Stock in** takes one serial per unit (optional), on the product page and on deliveries.
  - A serial already in stock is refused.
  - A serial sold before comes into stock again (a phone bought back).
  - More serials than units is refused.
- **A sale** can carry serials on its lines, or have them added afterwards from the sale's page (`POST /api/v1/sales/:id/serials`, for those who sell, give out goods or manage sales).
  - **At the counter**, a serial already sold or damaged is refused with a plain message, and the whole sale is not saved. More serials than units sold is refused.
  - **A sale that already happened** (offline, typed in) is kept. A conflicting serial is left off the sale, and the owner is told (`sale.serial_conflict`). Offline sales are never discarded.
  - A serial never recorded coming in (stock from before the switch) is recorded at the sale, as sold, with a note. It still cannot be sold twice.
- **A return** brings units back:
  - the serials named on the return come back;
  - with none named, all of the line's units come back when the whole line comes back.

  Units that go back on the shelf are "returned" and can be sold again. Units that do not are "damaged".
- **A cancelled sale** puts its units back in stock.

Stock quantities and value still move only through `StockService.applyMovement`. This follows the units; it does not change the books.

**Seeing it:**
- **The product page** shows the units in this shop by serial, and how many units have no serial recorded.
- **The sale's page** shows each line's serials, with a box to add missing ones.
- **The receipt and invoice PDF** print "Serial no.: …" under the item, which matters for warranty.
- **Find a serial number** (`GET /api/v1/stock/serials?q=`, at least 3 characters, a prefix match) shows:
  - the product, shop and status;
  - the sale, and the customer for those who may see customers;
  - the unit's history.

  Staff kept to one shop see that shop's units only. The page is linked from the Stock page when the business has products that keep serials.

## Consequences

- Transfers do not yet name serials. A unit sold from another shop moves its shop to where it was sold. Naming units on transfers can follow when a pilot needs it.
- Serials are not required at the counter. A serial-keeping product sells without them, so quick sale and voice sale work unchanged. The product page shows how many units have no serial. Making serials required could become a per-business setting later.
- `reserved` and `transferred` are allowed by the database, as the brief lists them, but nothing sets them yet.
- No new `serial.manage` permission. Stock in, selling, returns and cancelling keep their own permissions.
