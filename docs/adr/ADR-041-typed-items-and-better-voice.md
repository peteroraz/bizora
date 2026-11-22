# ADR-041: What staff can sell (typed items) and a better offline voice model

## Status

Accepted on 22 Nov 2026. Builds on ADR-035 (sale lines without a product) and ADR-040 (offline voice sales).

## Context

- **What the owner asked for.**
  - A business setting so a shop can sell only products from its list, sell any item typed in (remembered for next time), or both.
  - The first offline voice model (Whisper tiny English) did badly in the owner's own test. It should be reviewed and upgraded.
  - Items said that are not in the list should be accepted.
- **What already existed.**
  - The API accepted sale lines without a product (ADR-035) for services, booked as service income.
  - The quick sale screen could only sell products from the list.
- **The screen budget.** The quick sale screen was at 169.9 KB of its 170 KB script budget.

## Decision

### What staff can sell

- **`businesses.sales_items`:**
  - `products` (default; existing shops are unchanged);
  - `typed`;
  - `both`.

  Set in **Settings › Setup › What staff can sell** by whoever manages the business settings.
- **Typed lines.** A typed line is a sale line without a product with `saved: true`, plus a unit.
  - The server refuses typed lines at the counter when the shop sells products only (`TYPED_ITEMS_OFF`).
  - A sale made offline is kept, because the phone allowed it then.
  - Service lines without `saved` work as before.
- **Booking.** Typed items are goods, so they count as **sales** in the books, not service income.
  - No stock moves and no cost is recorded.
  - Their full price counts as sales; the cost of buying them shows through expenses or stock bought.
- **`saved_items`.** One per business per name, matched however it is typed.
  - The server remembers each typed item with its sale: the name as first typed, the latest unit and price, how many times it has sold, and when it last sold.
  - An older offline sale arriving late does not overwrite a newer price.
  - An item removed from the list comes back if it is sold again.
- **Endpoints.**
  - `GET /api/v1/saved-items` returns the setting and up to 2,000 items, to anyone who sells.
  - `DELETE /api/v1/saved-items/:id` is for whoever manages settings or products, and is audited.
- **On the phone.**
  - Saved items are kept with the other saved lists and cleared on sign-out.
  - A typed item sold offline is remembered on the phone at once, so it can be picked again with no network.
- **Quick sale.**
  - The search lists products and saved items, as the setting allows.
  - With typed items allowed, **Sell "…" (typed item)** adds what was typed. The line takes a unit (piece, bag, carton…) and a price.
  - Anyone who sells may set a typed item's price, because there is no list price to discount from. Free still needs a manager.
- **Fitting the budget.** The line editor, change calculator, split amounts, discount and note, credit fields and customer picker load separately.
  - All are fetched straight after the screen opens, so the first tap is instant and they are on the phone for offline use.
  - The quick sale is at 169.6 KB.

### Better offline voice

The models were benchmarked on 31 Nigerian English recordings (OpenSLR SLR70) and 36 spoken sales, each also with crowd noise mixed in. Full results are in `docs/voice/benchmark.md`.

| Set-up (round 2, crowd at 10 dB) | Download | Nigerian English, words wrong | With crowd noise | Spoken sales read right (clean) |
| --- | --- | --- | --- | --- |
| Whisper tiny.en (was shipped) | 64 MB | 21.6% | 110.8% (runs on) | 2 of 36 |
| **Whisper base.en 8-bit + shop prompt + cap (Standard)** | 77 MB | 15.7% | 28.3% | 10 of 36 |
| **Whisper small.en 8-bit + shop prompt + cap (Best accuracy)** | 249 MB | 12.4% | 20.2% | 19 of 36 |
| Moonshine base + cap | 123 MB | 10.1% | 33.0% | 7 of 36 |

- **Standard: Whisper base.en**, encoder and decoder 8-bit. About the same download as before, about a quarter fewer words wrong on Nigerian English, and no runaway output in noise.
- **Best accuracy: Whisper small.en**, 8-bit. Offered in Settings for phones with 4 GB of memory or more (or that don't say); it takes about twice as long to read.
  - One model is kept on the phone at a time.
- **Shop prompt.** Whisper is told the currency word and this shop's product and customer names before it listens.
  - The library has no prompt option, so they go in as the first tokens (`<|startofprev|>` … `<|startoftranscript|>`).
  - This was the biggest gain for sales: 1 to 10 of 36 right for base, 5 to 19 for small.
  - Moonshine was best on clean sentences but can't take a prompt and did worse on sales and noise.
- **Length cap.** Output is capped at about 8 tokens per second of recording, which stops runaway repeats.
- **Recording clean-up** (`lib/voice/clean.ts`):
  - an 80 Hz high-pass filter;
  - silence trimmed either side;
  - quiet speech levelled (gain up to 20×);
  - "nothing heard" when under a quarter of a second of speech;
  - words the model writes for silence or music ("[BLANK_AUDIO]", "Thank you.") are dropped.
- **Spellings.** The parser reads "to/too/for" right before a unit as 2/2/4, and common misheard units ("backs" means bags).
- **Items not in the list.** When the shop allows typed items, the review sells an item said but not found as a **new typed item** (`new_item`, which does not block), priced as said, and it is remembered.
  - When products only, it blocks as before and says the owner can allow typed items in Settings.
- **Offline.** The voice panel is also fetched straight after the quick sale opens, so opening it for the first time with no network works.

## Consequences

- **Hashes.** New models are fetched once with `--allow-unlocked` in CI to record their hashes, then the lock is committed and strict checking returns. Done for base.en (`51eefc0a`) and small.en (`482fb8ba`) on 22 Nov 2026.
- **Real speech in CI.** With the network off, Standard heard the robot-voice recording "Sold two bags of rice at seventy five thousand naira each, cash" as "sold two bags of rice at 75,000 each, cash." The old model heard "sold to bags of rice at 75,000, every each cash."
- **Image size.** The web image carries both models, about 330 MB.
- **Accuracy.** Still English only. Real accents were measured on read-out sentences, not real market sales. Spoken-sale tests use a robot voice, so an on-device test with traders is still needed.
- **Typed items have no cost,** so their whole price shows as sales. Owners who need item profit should add the item as a product.
- **The quick sale budget stays tight** (169.6 KB). New features on that screen need to load separately.
