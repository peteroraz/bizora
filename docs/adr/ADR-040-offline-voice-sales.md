# ADR-040: Offline voice sales

## Status

Accepted on 20 Nov 2026. Builds on ADR-015 (offline outbox and service worker), ADR-018 (AI capture) and ADR-033 (photos and voice through Bizora AI).

## Context

- **The ask.** Traders want to say a sale out loud, for example "I sold five bags of rice at seventy-five thousand naira each to Emeka. He paid three hundred thousand and will balance seventy-five thousand." It must work with no network and cost nothing per use.
- **What already existed.**
  - Voice capture through Bizora AI (ADR-033). It needs a network and counts against the daily limit.
  - An offline outbox. Each sale has its own ID, which doubles as the idempotency key.
  - `/api/v1/sync/push` and the quick sale save, which already handle offline sales, sales that take stock below zero, and credit rules.
- **Constraints.**
  - Phones are often low-end Android with little storage.
  - The data plan is expensive.
  - Accents vary.
  - Money must be exact.
  - Nothing may be saved from speech the trader has not checked.

## Decision

### Speech to words on the phone

- **Model.** Whisper tiny English (`onnx-community/whisper-tiny.en`). The encoder runs at full precision and the decoder is 8-bit, about 66 MB in all.
- **How it runs.** Transformers.js 4.3.2 drives ONNX Runtime Web in a Web Worker. It uses WebGPU where the browser offers it and falls back to WebAssembly on the processor, with one thread because the site is not cross-origin isolated.
- **Where the files come from.**
  - Model and runtime are served by Bizora itself, under version-pinned paths (`/voice/models/<version>/<id>/`, `/voice/ort/<ort version>/`).
  - Nothing is fetched from Hugging Face or a CDN at run time (`allowRemoteModels = false`).
  - `scripts/voice-assets.mjs runtime` copies the runtime from `node_modules` before every build.
  - `scripts/voice-assets.mjs models` fetches the model in CI and in the Docker build. It checks each file against `src/lib/voice/models.lock.json` (SHA-256).
  - The first fetch records the hashes; after that, a changed file stops the build.
- **Storage.** The trader downloads it once, on purpose, after seeing its size.
  - Files are kept in a Cache API store named after the model and runtime versions (`bizora-voice-…`), and persistent storage is requested.
  - A note in localStorage lists the files. On each visit Bizora checks the cache still has every one; if the phone removed any to free space, it says so and offers to download again.
  - Old versions are deleted when a new one is installed.
- **Service worker (v3).**
  - Serves `/voice/` from the cache first.
  - Never deletes `bizora-voice-` caches on update.
  - Caches `/app/sales` for offline use, so sales waiting to sync can be seen.
- **Sound.**
  - Recorded for at most 30 seconds and turned into 16 kHz mono in memory.
  - Moved, not copied, to the worker, then dropped.
  - Never written to storage and never uploaded.
- **Security policy.** CSP gains `'wasm-unsafe-eval'`, which lets WebAssembly compile but does not allow `eval()`, and `worker-src 'self' blob:`.

### Words to a sale, without AI

- **Parser.** `@bizora/contracts/voice` is plain TypeScript with no model, and gives the same answer every time for the same words.
  - `tokenize` reads number words ("seventy-five thousand", "one and a half", "3.5k", "₦12,000") into exact thousandths as `bigint`.
  - `parseSpokenSale` finds:
    - items: product words, quantity, unit, and "at … each", "… for all" or "per";
    - the customer: "to Emeka", or "Chinedu collected";
    - the payments, the money paid, the balance and the total said.
  - Money is kept in minor units, and line totals use the same half-up rounding as the server.
  - It reports problems instead of guessing, for example: no price, a price that could be each or for all, a total that does not add up, or a payment that does not add up.
- **Words per language.** Market words live in a `VoiceLexicon` pack. Only English is shipped and tested. The pack shape is ready for Nigerian Pidgin, Igbo, Yoruba and Hausa, but none is claimed until tested with speakers.
- **Matching names.** `match.ts` matches spoken names to the phone's saved product list and customer names with:
  - normalised names;
  - a Jaro-Winkler score;
  - a sound key;
  - unit and honorific words dropped (honorifics only for people).

  The result is "sure", "choose one of these" or "not found". It never picks silently when two are close.
- **Review.** `buildReview` turns the parsed sale into the quick sale's own lines, prices, customer and payments, mirroring the server's rules:
  - A spoken price different from the list price needs the price-change permission. Without it, the review asks for a manager, as the quick sale does.
  - An amount that could be each or for all is shown both ways for the trader to choose. It is never quietly replaced by the list price.
  - Money still owed needs a customer allowed credit, a date and a note.

### Customers on the phone

- `GET /api/v1/customers/directory` returns names, IDs and credit-allowed only, never phones or emails.
- People who may read all customers get up to 5,000.
- Lookup-only roles, such as a cashier, get customers allowed credit plus those who bought in their shop in the last 90 days, up to 2,000.
- Saved per business and per person. Cleared on sign-out with the saved product list. Sales waiting to sync are kept.

### Saving

- **Nothing is saved until the trader taps Confirm sale.** Confirming fills the quick sale with the reviewed lines and saves it through the normal path:
  - online, straight to the server;
  - offline, into the outbox with a summary (items, total, customer, "by voice") shown in "Sales on this phone, not yet confirmed".
- **Syncing once.** Sync sends the sale with its own ID, so a resend is a duplicate, not a second sale.
- **Credit and stock.** The server checks credit and stock again; a refused sale shows "Needs review".

### Screens

- **Quick sale.** A full-width "Record sale by voice" button above the product search.
- **Sales.** "Record sale by voice" opens it directly (`?voice=1`). The PWA shortcut opens it too.
- **The voice panel.**
  - Shows network and model status.
  - Lets the trader download with progress, record with a timer, or type the sale in words.
  - Online, it can use Bizora AI.
  - The review offers Confirm sale, Edit details, Record again and Cancel.
- **Settings › Appearance › Offline voice on this phone.** Status, size, room left, download and remove.

## Consequences

- **No speech costs.** Nothing is sent to a speech service; only the one-time download uses data.
- **The download.** About 80 MB on WebAssembly (model 66 MB plus 14 MB runtime), or 93 MB with WebGPU. Some phones will refuse for lack of room; Bizora checks first and says so.
- **Accuracy.** The tiny English model is the smallest that is useful. It has not been measured on Nigerian accents (see `docs/voice/README.md`), so the review step is mandatory and every value can be edited.
- **The Docker image** grows by about 110 MB (model and runtimes). Webpack also emits a spare copy of the WebGPU runtime under `_next/static/media`, which is unused.
- **After a Bizora update,** the voice screen must be opened once online before it works offline, like the other offline screens.
- **Pinning.** `models.json` points at the `main` revision until the first CI fetch records the commit. Then the lock is committed and the revision pinned.
