# Pilot mobile test matrix

Automated checks run in CI on every PR. Real phones must be checked by hand before each pilot release; this sandbox has no physical devices. Fill in the results table and keep it with the release.

## Automated (every PR)

| Check | Test |
| --- | --- |
| 13 main screens at 320 and 360 px: no sideways scrolling, controls at least 40 px tall | `apps/web/e2e/mobile-layout.e2e.ts` |
| Script budget per screen, and loading speed under a slow network | `apps/web/e2e/performance-budget.e2e.ts` |
| Offline: opens with no network, sale saved, survives reload and closing the tab, synced once, kept in its shop, refusals named | `offline.e2e.ts`, `offline-hardening.e2e.ts`, `voice-offline.e2e.ts`, `typed-items.e2e.ts` |
| Voice with the network off (real model, robot voice) | `voice-model.e2e.ts` (CI) |

## Phones to test by hand

| Class | Example | Why |
| --- | --- | --- |
| Low-end Android | 2 GB RAM, Android 10–12, Chrome (e.g. Tecno Spark, itel A-series, Samsung Galaxy A03) | Most pilot staff phones; memory and speed |
| Mid-range Android | 4 GB RAM, Android 12–14 (e.g. Infinix Hot, Samsung Galaxy A15) | Owners; WebGPU on some |
| Modern Android | 6–8 GB RAM, Android 14+ (e.g. Pixel 7, Galaxy S23) | Best accuracy voice model |
| iPhone (optional) | iOS 17+, added to the home screen | Owners who use iPhones |

For each phone, test in **Chrome** and as an **installed app** (Add to home screen), in **portrait**.

## Flows to check on each phone

| # | Flow | What to look for |
| --- | --- | --- |
| 1 | Sign up and set up the business | Keyboard does not cover the field being typed; Next buttons reachable |
| 2 | Add a product with opening stock and a photo | Camera opens; photo uploads on a slow network |
| 3 | Record a cash sale, a transfer sale and a credit sale | Totals readable; buttons not clipped; receipt opens |
| 4 | Share the receipt to WhatsApp, and email it | Link opens on another phone |
| 5 | Take a debt payment | Balance updates once |
| 6 | Look up stock | List scrolls smoothly; numbers readable |
| 7 | Turn on airplane mode; record two sales; close the app; open it again | Both sales still waiting; badge visible |
| 8 | Turn the network back on | Badge clears within a minute or on tap; sales appear once |
| 9 | Voice: download Standard in Settings, then record a sale with airplane mode on | Size shown before download; Stop works; review shown; nothing saved until Confirm sale |
| 10 | Sign out and sign in again | Refused while anything is waiting; works after sync |
| 11 | Open Settings tabs, Money, Debtors | No sideways scrolling; tabs tappable |

## Results

| Phone | Android / browser | Installed app | Flows passed | Problems found | Tester | Date |
| --- | --- | --- | --- | --- | --- | --- |
| | | | | | | |
