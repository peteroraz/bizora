# ADR-025: A homepage for any business, anywhere

## Status

Accepted on 18 Nov 2026 (Sprint 6e). Replaces the 6d homepage, which addressed only Nigerian shops.

## Context

Bizora is for businesses in any country and of any kind. The page should feel current and alive, without becoming heavy on cheap phones.

## Decision

- **Wording:** no country in the copy. The page names kinds of business (shops, wholesalers, pharmacies, salons, bakeries, tailors, repairers, market stalls, building supplies) and currencies (naira, cedis, shillings, rand, rupees, euros, dollars). Every claim matches what the product does today: offline sales, WhatsApp receipts, staff roles and PINs, photo capture, bank matching, any base currency, business links. No prices are shown until pricing is decided.
- **One moment of motion:** a till receipt prints in the hero, is stamped PAID, and gives way to the next business's. There are five businesses in five countries and currencies (Accra GHS, Nairobi KES, Lyon EUR, Lagos NGN, Pune INR), each ending with its own link (`<host>/<handle>`), so the hero shows both "anywhere" and "your name on every receipt".
  - It is CSS only (`app/landing.css`): no JavaScript, and no animation library.
  - It runs on a 25-second loop, 5 seconds per receipt.
  - With reduced motion, one finished, stamped receipt shows.
- **Look:**
  - The hero is a full-bleed deep teal, the brand colour, with white paper and red stamp ink. These are the `--landing-*` tokens in `packages/ui/src/globals.css`, fixed in both themes.
  - The rest of the page uses the app's own tokens.
  - Type is Geist Sans, set large and tight. Geist Mono is used only on the receipt.
  - There are no stacks of identical cards. Features sit beside real phone screens of the app.
- **Sections:** the hero, then three features against real screens and one about business links, a large run of business kinds, three numbered steps, five questions, and a closing band.
- **Page weight:** it stays a server component with lazy images and no client JavaScript of its own.

## Consequences

- The receipts are made up and marked by their variety. They do not claim real customers or testimonials.
- The phone screenshots still show one Lagos shop in naira. They can be swapped for mixed currencies later.
