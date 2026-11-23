# ADR-044: Offline, small-screen and low-bandwidth hardening for the pilot

## Status

Accepted on 23 Nov 2026. Builds on ADR-015 (offline outbox), ADR-040 and ADR-041 (offline voice).

## Context

The pilot puts Bizora on low-end Android phones with networks that come and go. A review of the offline layer, the main screens at 320 and 360 px, and download behaviour found:

1. **Offline work moved shops.** Items didn't record their shop, so the server used whichever shop the person had selected when they synced. A cashier who sold offline in Shop A, then switched to Shop B before the network came back, put the sale, its stock and its cash into Shop B.
2. **Sync failures were invisible.** "3 changes waiting to sync" didn't say that the last try had failed, and there was no way to try again. Refused items showed the error but not which sale it was.
3. **Tabs disagreed.** Another open tab kept showing items as waiting after one tab had synced them.
4. **No offline customer search.** A sale on credit to an existing customer couldn't be recorded offline: the customer search needed the server, even though the names were already saved on the phone for voice.
5. **Lazy parts and offline.** Parts of New sale loaded on demand weren't always on the phone when the network dropped. Fixed in ADR-041 by fetching them right after the screen opens. The customer search's saved-names module was split into a second copy that wasn't fetched; it is now imported directly.
6. **Small tap targets** on the main screens: the account button (36 px), Settings tabs (38 px), debtor filters (30 px), and several bare links (20 px). Nothing scrolled sideways at 320 px.
7. **Voice download** could not be stopped once started.

## Decision

- **Shop per item.** The outbox owner carries the current shop. `enqueue` writes `branchId` into every item, and the sync service runs each item in that shop after checking:
  - it is this business's shop;
  - it is still open;
  - the person may work there.

  Otherwise the item is refused with a plain reason and shown under "could not be saved", never silently moved. Items from older app versions, which have no `branchId`, behave as before.
- **Sync status.**
  - The badge is a button that tries straight away.
  - After a failed try it reads "N changes not synced yet. Last try failed: tap to try again".
  - Refused items show their summary (for example "Rice 50kg ×2") with the reason.
  - Outbox changes are broadcast to other tabs (`BroadcastChannel`).
- **Offline customer search.** With no network, the search uses the customer names saved on the phone (names, IDs, credit allowed; cashiers get a limited list, ADR-040). New sale refreshes that list at most every 6 hours, to spare data.
- **Nothing is discarded silently.**
  - Refused items stay until the person dismisses them after reading.
  - Signing out or leaving Shop mode is refused while anything is waiting.
  - Items belong to one person in one business and are only sent with that person's sign-in.
- **Conflicts.** The server decides. Each item has its own ID, which doubles as the idempotency key, so resends are duplicates, not new records.
  - Credit is checked again, and a customer whose credit was stopped meanwhile is refused (named on screen).
  - Stock may go below zero for offline sales (flagged, ADR-015).
  - Work done offline outside opening hours or in a locked shop is kept and reported to the owner (ADR-034).
- **Small screens.** Controls are at least 44 px tall. `e2e/mobile-layout.e2e.ts` opens 13 main screens at 320 and 360 px with a real business, and fails on sideways scrolling or any control under 40 px (links inside sentences excepted).
- **Low bandwidth.** These were reviewed and are kept:
  - sales and customer lists are paged (`SALE_PAGE_SIZE`, `CUSTOMER_PAGE_SIZE`);
  - photos are shrunk to JPEG at 80% on the phone before upload;
  - product lists and stock are cached on the phone and refreshed when online;
  - parts loaded on demand are fetched after the screen opens, not before;
  - the voice model downloads only when the person taps Download.

  New: the model download can be **stopped** (what is already saved is kept, so trying again carries on) and **retried**. Phones that report under 2 GB of memory are told that typing the sale works just as well.

## Tests

- **`e2e/offline-hardening.e2e.ts`:**
  - a sync dropped mid-way is shown as failed, survives a reload and closing the tab, and is sent once even when two tabs try together;
  - a sale refused because credit was stopped meanwhile is named on screen while the cash sale syncs;
  - a sale saved offline stays in its shop after the owner switches shop.
- **`e2e/mobile-layout.e2e.ts`:** 13 screens at 320 and 360 px.
- **Existing:** `e2e/offline.e2e.ts`, `voice-offline.e2e.ts` (reload offline, sync once), `typed-items.e2e.ts` (offline typed items), and the API's `offline-sync.test.ts` and `financial-integrity.test.ts` (offline replays never double).

## Consequences

- **Older items.** Items already waiting on phones from before this change sync into the shop selected at the time of sync, as before.
- **The quick sale budget** is at 169.9 KB of 170 KB.
- **Not testable in automation:** real low-memory behaviour, the virtual keyboard covering inputs, and installed-app (PWA) mode on real Android phones. These are in the manual device matrix (`docs/PILOT_MOBILE_TEST_MATRIX.md`).
