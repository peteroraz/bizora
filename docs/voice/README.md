# Offline voice sales

A trader says a sale out loud. The phone turns the speech into words, reads the words into a sale, and shows it for checking. Nothing is saved until the trader taps **Confirm sale**. With no network, the sale waits on the phone and is sent once when the network is back. The design is in [ADR-040](../adr/ADR-040-offline-voice-sales.md).

## How it works

```
microphone ─► recorder.ts (≤30 s, 16 kHz mono, memory only)
           ─► speech.worker.ts (Whisper tiny.en · Transformers.js · ONNX Runtime Web: WebGPU or WASM)
           ─► words (editable)
           ─► @bizora/contracts/voice: tokenize → parseSpokenSale → buildReview (saved products + customer names)
           ─► review screen (trader checks, edits, confirms)
           ─► quick sale save ─► online: POST /api/v1/sales
                               └► offline: outbox (IndexedDB) ─► /api/v1/sync/push (sale ID = idempotency key)
```

| Part | Where |
| --- | --- |
| Number and market words | `packages/contracts/src/voice/lexicon.ts`, `tokens.ts` |
| Words to a sale | `packages/contracts/src/voice/spoken-sale.ts` |
| Name matching | `packages/contracts/src/voice/match.ts` |
| Review rules (price, credit, units) | `packages/contracts/src/voice/review.ts` |
| Speech engine, install, storage checks | `apps/web/src/lib/voice/engine.ts`, `speech.worker.ts`, `recorder.ts` |
| Model registry and lock | `apps/web/src/lib/voice/models.json`, `models.lock.json` |
| Asset script | `apps/web/scripts/voice-assets.mjs` |
| Screens | `apps/web/src/components/voice-sale.tsx`, `waiting-sales.tsx`, `voice-settings.tsx` |
| Customer names for the phone | `GET /api/v1/customers/directory`, `apps/web/src/lib/offline/customers.ts` |

## Setup

- **Local development.**
  - `pnpm install`, then `pnpm dev`. `predev` copies the speech runtime into `apps/web/public/voice/ort/`.
  - To use real speech, run `pnpm --filter @bizora/web voice:models` once. It needs access to huggingface.co and checks every file against the lock.
  - Without the model, the panel says offline voice is not available yet. Typing the sale in words, and Bizora AI when online, still work.
- **CI.** The e2e job:
  - fetches the model (cached by the hash of `models.json` and the lock) and prints the lock;
  - makes a robot-voice test recording with `espeak-ng`;
  - runs the browser tests.
- **Docker / Cloud Run.**
  - `apps/web/Dockerfile` fetches the model before `next build`, so the site serves it from `/voice/`.
  - If the fetch fails, the build continues and offline voice shows "not available yet".
  - `/voice/*` is served with `Cache-Control: immutable`, since every path has a version in it.
- **Pinning.** The model is pinned to commit `794207fe…` of `onnx-community/whisper-tiny.en`. Every file's SHA-256 is in `models.lock.json`, recorded from the first CI fetch on 20 Nov 2026. A changed or unlisted file fails the fetch.
- **Changing the model.** Add a new entry with a higher `version` and a pinned `revision`, fetch once with `--allow-unlocked`, check the hashes, and commit the lock. Phones delete the old cache when they install the new one.

## For traders (user guide)

1. **Set up once (needs a network, ideally Wi-Fi).**
   - Open **New sale** and tap **Record sale by voice**, then **Download offline voice**.
   - It is about 80 MB and stays on this phone.
   - You can also do this in **Settings › Appearance › Offline voice on this phone**, which shows the size and lets you remove it.
2. **Open Bizora once with a network,** so your products and customer names are saved on the phone.
3. **Record a sale.**
   - Tap **Record sale by voice**, then **Tap and speak**.
   - Say the sale, for example: *"Five bags of rice at seventy-five thousand each to Emeka. He paid three hundred thousand, balance seventy-five thousand."*
   - Tap **Stop**. Up to 30 seconds.
4. **Check it.**
   - Fix any wrong words and tap **Read again**, or change the product, quantity, price, customer or payment directly.
   - Anything Bizora is unsure about is listed in plain words.
   - If money is still owed, add the date and a note.
5. **Tap Confirm sale.**
   - With no network, it shows under **Sales › Sales on this phone, not yet confirmed**.
   - It is sent by itself when the network is back.
   - If Bizora refuses it (for example, the customer is not allowed credit), it shows **Needs review**.
6. **No microphone, or noisy?** Tap **Type the sale in words instead**; it is read the same way.

Tips:

- Say the unit ("bags", "cartons", "tins").
- Say "each" or "for all" after a price.
- Say the customer's name as it is saved.

## For developers

- **Adding words.** Market words and units go in `ENGLISH` in `lexicon.ts`. Test them in `spoken-sale.test.ts`.
- **Adding a language.**
  - Add a `VoiceLexicon` pack (number words, markers, units, payment words).
  - Add a speech model entry for it.
  - Do not ship or claim a language until it has been tested with native speakers on real phones.
- **Keep one source of rules.** The review mirrors the server: price changes need `SALES_DISCOUNT`, and credit needs a customer allowed credit, a date and a note. The server checks everything again on save and sync.
- **Never post from speech.** `onDone` is called only from the Confirm button; `save` is a separate step on the quick sale page.
- **Tests:**
  - `pnpm --filter @bizora/contracts test`: parser, numbers, matching and review (examples from the brief included).
  - `pnpm --filter @bizora/api test -- voice-sync`: the directory's privacy and tenant isolation; syncing the brief's sale once (resends, a new operation ID); refused credit; stock below zero; sign-in required.
  - `pnpm --filter @bizora/web test`: saved customer names (per person, kept offline, cleared on sign-out, waiting sales kept) and install-state checks.
  - `pnpm --filter @bizora/web e2e -- voice`: in a real browser, with the network switched off:
    - type the brief's sale, check the review, confirm, see it waiting (also after a reload), go online, synced once (debt ₦75,000, stock 5 bags);
    - a cancelled review saves nothing;
    - with the model present, real speech from a recording with the network off.

## Browser support

| Needs | Why |
| --- | --- |
| WebAssembly with SIMD | the speech runtime |
| Web Workers (module), Cache API, IndexedDB | running off the page, keeping the model and sales |
| `getUserMedia` (HTTPS) | the microphone |
| WebGPU (optional) | faster on phones that have it |

| Browser | Expected | Tested here |
| --- | --- | --- |
| Chrome for Android 114+ | WASM; WebGPU on Android 12+ with supported chips | No (no physical device in this build) |
| Chrome / Edge desktop (recent) | WASM and WebGPU | Chrome for Testing 153 (Linux, headless): typed path offline. Real speech runs in CI with the model |
| Samsung Internet 22+ | WASM | No |
| Safari iOS 16.4+ | WASM; WebGPU from iOS 26 | No. Storage may be cleared after 7 days unused unless the app is installed to the home screen |
| Firefox Android | WASM | No |
| Opera Mini, KaiOS, very old Android WebView | Not supported; "type the sale in words" still works | No |

The panel checks what the browser has and says plainly when offline voice cannot run.

## Test report

| Area | Status |
| --- | --- |
| Parser: brief examples 1 and 2, cash, split payments, "k" amounts, comma prices, each vs for all, mismatched totals, overpaid, currency words | Passing (unit) |
| Name matching: close names, choose-one, unknown, honorifics, units | Passing (unit) |
| Review: price permission, list price, unclear amount, credit rules, units sold | Passing (unit) |
| Server: directory privacy and isolation, sync once, duplicates, refused credit, stock below zero, sign-in | Passing (API, PGlite) |
| Browser, offline: typed sale → review → confirm → waiting → reload → sync once | Passing (Playwright, Chrome 153) |
| Browser, offline: cancel saves nothing; Read again refreshes the review | Passing (Playwright) |
| Browser, real model offline (espeak-ng recording) | Runs in CI where the model can be fetched; skipped in this sandbox, which cannot reach huggingface.co |
| Nigerian English accent accuracy | **Not measured.** espeak-ng is a robot voice, not a Nigerian accent |
| WebGPU on real phones, low-end Android speed, memory, battery | **Not tested** on devices |
| Pidgin, Igbo, Yoruba, Hausa | **Not supported yet** (architecture only) |

Suggested device check before wide release:

- a low-end Android (2–3 GB RAM, Chrome);
- a mid-range Android with WebGPU;
- an iPhone with the app on the home screen.

Record 20 real sales from traders on each, and log the words heard against the words said.

## Security and privacy

- **Sound** stays in memory, is moved to the speech worker, and is dropped after reading. It is never stored or uploaded.
- **Words and sales** stay on the phone until confirmed. Confirmed offline sales sit in the existing outbox, tied to the business and person, as all offline work is.
- **Customer names on the phone** are names, IDs and credit-allowed only, saved per business and per person. Cashiers get a limited list. Cleared on sign-out with the saved product list.
- **Kept on sign-out:** the speech model, which holds no business data, and sales waiting to sync, so nothing is lost.
- **Tenant isolation.** The server never trusts the phone's business or customer: the sale is checked again on sync, and a customer from another business is refused.
- **Model integrity.** Version-pinned paths, served from Bizora's own site, SHA-256 lock checked at build.
- **CSP.** `'wasm-unsafe-eval'` (WebAssembly only, not `eval`) and `worker-src 'self' blob:`. Scripts still need the page nonce.

## Licences

| Component | Licence | Notes |
| --- | --- | --- |
| OpenAI Whisper (tiny.en) | MIT for the code and weights in github.com/openai/whisper; the Hugging Face card for `openai/whisper-tiny.en` is tagged Apache-2.0 | Both allow commercial use and redistribution with the notice. `NOTICE.txt` is written beside the served model |
| ONNX conversion `onnx-community/whisper-tiny.en` | No separate licence stated; derived from the above | |
| Transformers.js (`@huggingface/transformers` 4.3.2) | Apache-2.0 | |
| ONNX Runtime Web (`onnxruntime-web` 1.31.0-dev) | MIT | |
| espeak-ng (CI test recording only, not shipped) | GPL-3.0 | Used as a tool in CI; nothing from it is distributed |

## Known limitations

- **English only.** The tiny model is not tuned for Nigerian accents, so the review step matters; every value can be edited.
- **The download** is about 80 MB (93 MB with WebGPU). Phones low on space are told before downloading. The phone may remove it to free space; Bizora notices and offers to download again.
- **30 seconds** per recording. One sale per recording.
- **After a Bizora update,** open the voice screen once with a network before using it offline.
- **The offline customer list** is limited (5,000, or 2,000 for cashiers) and is as fresh as the last time Bizora was opened online. A new customer cannot be created from voice offline; pick walk-in or add them on the Customers screen.
- **Quantities and prices** use the shop's base currency. A different currency said is flagged, not converted.
