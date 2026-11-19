# ADR-033: No plan limits for now, AI reads per shop, product photos, and voice for sales and stock

## Status

Accepted on 19 Nov 2026 (Sprint 7g). From the owner's requests of 19 Nov.

## Context

The owner asked for:

- **Voice for sales.** A sale can be said on the spot, or come from a recorded voice note.
- **Voice for stock.** The same for stock: counts, damaged or missing goods, and moves between shops.
- **Product photos.** Up to five pictures per stock item.
- **No limits for now.** Starter and Pro limits are lifted. Each shop gets 100 AI reads a day.

Before this sprint:

- AI reads were counted per business, so one busy shop used up the others' reads.
- Voice capture covered sales lists, deliveries and price lists only. It had no quick-sale cart and no counts, changes or moves.
- The file picker took photos and PDFs but not voice notes forwarded from WhatsApp.

## Decision

### Limits

- **Migration 0030** sets both plans (starter, business) to very high branch, staff and device limits, turns every feature on, and sets `ai_daily_reads` to 100.
  - Plans stay in the database, so pricing can bring limits back later with a new migration. No code changes are needed for that.
- **`AI_DAILY_CAPTURE_LIMIT`** is the server's own ceiling. It now defaults to 100. A shop's allowance is the lower of the plan's figure and this ceiling.

### AI reads per shop

- **`ai_usage`** now has a `branch_id`, with primary key (tenant, shop, day).
- **The shop counted** is the one being worked in. If the person is working across all shops, it is their own shop if they have one, otherwise the first open shop.
- **When a shop runs out,** the message says that this shop has used its reads for today. Other shops are not affected.

### Product photos

- **Storage:** `product_photos` (migration 0031) holds up to five JPEG or PNG photos per product, at positions 0–4. Position 0 is the main photo. Photos are stored in the database, as logos are. If storage grows, moving them to object storage is a later decision.
- **Checks on the server:**
  - the type, width and height are read from the file itself, not from what the browser says;
  - photos under 64 px or over 1600 px on a side are refused, as are files over 600 KB;
  - a sixth photo is refused with `TOO_MANY_PHOTOS`.
- **On the phone,** a photo is shrunk to 1280 px JPEG before upload, so uploads stay small on mobile data.
- **Who can do what:**
  - anyone who can see stock can view photos;
  - only those who manage products (`products.manage`) can add, remove or reorder them.
- **Serving:** images are served with `nosniff`, private caching and an ETag. The URL changes when the photo changes.
- **History and lists:** adding and removing a photo show in the product's history. The main photo shows in the stock list.

### Voice for sales (target `cart`)

- **"Say it" on the quick sale screen** opens a small voice panel. The panel's code loads only when it is opened, so the quick sale stays inside its 170 KB budget.
- **What the AI returns:** product, quantity, unit, price, payment, amount paid and customer.
- **Matching:** rows are matched to the shop's products on the phone. A product matches by exact name, or when exactly one product's name contains the spoken name.
- **What fills in:**
  - matched lines go into the cart;
  - the payment method is set, except in desk flow, where the cashier takes the money;
  - cash given is filled when the sale is said to be in cash.
- **What does not fill in:** names that match no product, and the customer's name, are shown to the cashier instead of being guessed.
- **Nothing is sold by hearing it.** The cart is checked and recorded as any other sale. Every existing check still applies: stock on the shelf, prices, discounts and credit.
- **Who can use it:** anyone who can make sales (`sales.create`). The store keeper cannot.

### Voice for stock (targets `stock_count`, `stock_change`, `stock_move`)

- **New page, "Say or snap stock" (`/app/stock/lists`),** with three kinds:
  - **Count**, needing `stock.count`;
  - **Damaged, missing or found**, needing `stock.adjust`;
  - **Move to another shop**, needing `stock.transfer`.
- **Each kind uses the shared review table.** Rows can come from speaking, a forwarded voice note, a photo of a sheet, or a CSV file.
- **New imports:** `POST /imports/stock-count`, `/stock-change` and `/stock-move`. They check first, then save all rows in one transaction, as the other imports do.
  - **Count:** rows go through the normal count. An owner's or manager's count applies at once. A store keeper's count waits for approval.
  - **Change:**
    - every row needs a short note;
    - the reason must suit the direction: damaged, expired, missing, own use, gift or other when taking off; found or correction when adding;
    - traders' words are understood, for example "got wet" means damaged, "can't find" means missing and "dash" means gift.
  - **Move:** the receiving shop is found by name among the business's other open shops.
- **Never below zero:** the check adds up every row against what is on the shelf, so a list cannot take a shelf below zero and a save never fails halfway.
- **Activity log:** each save records `import.saved` with its kind and source.

### Voice notes from other apps

- **The picker** now takes `audio/*` files as well as photos and PDFs.
- **File types are cleaned up before sending:**
  - WhatsApp `.opus` files, which often arrive with no type, are sent as `audio/ogg`;
  - `.m4a` files are sent as `audio/mp4`;
  - AAC, AMR and 3GPP are accepted.

## Consequences

- **The quick sale bundle is at 169.7 KB of 170.** Any new feature on that screen must load only when it is used.
- **Prices:** limits are off for every business until pricing is decided. Bringing limits back is a migration plus a decision on how to treat businesses already over a limit.
- **Photo storage** in Postgres grows by up to about 3 MB per product with five photos. At about 10,000 photographed products, moving photos to object storage should be looked at again.
