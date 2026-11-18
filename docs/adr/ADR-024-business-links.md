# ADR-024: Links that come from the business

## Status

Accepted on 18 Nov 2026 (Sprint 6e). The owner chose the "business name in the link" option over per-business sub-addresses or custom domains, which need a wildcard certificate and a load balancer. Builds on ADR-021 (branding) and ADR-022 (customer pages).

## Context

Customers receive receipts, invoices and statements on WhatsApp as links like `/r/x7Kp2…`. They looked like they came from Bizora, not from the shop. Owners want the customer to see, before and after tapping, that the message is from their business.

## Decision

### A link name per company

- `organizations.handle` (migration 0024) is unique and not null, with the format checked in the database:
  - lowercase letters, numbers and single dashes;
  - 3–40 characters;
  - not starting or ending with a dash.
- Names Bizora uses or may use (`app`, `api`, `login`, `r`, `s`, `health`, `ready`, …) are reserved: `RESERVED_HANDLES` in contracts, and the same list in the migration.
- **Existing companies** got a name from their own name. A clash or a reserved word adds a short piece of the company id.
- **New companies** get their name at sign-up (`uniqueHandle`), with the same fallback.
- **The owner** (`branding.manage`, organization-wide) changes it in Settings → Your brand → Your business link. The screen checks the name as it is typed (`GET /organizations/current/handle-check`). Taken names get a 409 `HANDLE_TAKEN`, also when two owners race. The change is audited as `profile.updated`, with from and to.
- **About line:** an optional `about` line (280 characters) describes the business on its page.

### Links and pages

- **Link format:** links read `/<handle>/r/<token>` (receipts and invoices) and `/<handle>/s/<token>` (statements). The token alone finds the document, exactly as before; the name is for people.
- **Wrong or old names:** if the address carries an old or wrong name, the page moves to the right one. Nobody can show another business's receipt under their own name.
- **Short links:** links sent before 6e (`/r/<token>`, `/s/<token>`) keep working and move to the named link.
- **Business page:** `/<handle>` shows the business's page: logo, name, about, address, and Call and WhatsApp buttons. It shows nothing about sales, customers or money (`GET /public/profiles/:handle`, and `/logo`).
- **Search engines:** all these pages are `noindex`. They are reached through links the business shares, not search.
- **Brand colour:** customer pages show the business's colour as a band at the top, when it is readable, and link the business name to its page.

### What WhatsApp shows when a link is shared

- **Title:** the page title is the business speaking, e.g. "Receipt R-000214 from Ama's Hair Studio" or "Your statement from Ada Stores".
- **Picture:** `/<handle>/opengraph-image` draws a 1200 × 630 card on the server with the business's logo or initial, name, colour and about line, and "Sent with Bizora" small. The business page uses it, and its receipt and statement pages inherit it. The card never shows amounts, customers or numbers from the document.
- **Absolute addresses:** the root layout sets `metadataBase` from the address the visitor came in on, so preview pictures have absolute addresses.
- **Message text:** the WhatsApp message is written as the business: "Hello Mama Chika, here is your receipt R-000001 from Ada Stores: <link>".

## Consequences

- Links still sit on Bizora's domain. Sub-addresses or a business's own domain can come later behind a load balancer; the handle is already the key they would use.
- Changing the name changes new links only. Old links keep working through the token and the redirect.
- WhatsApp caches previews, so a logo change may take a while to show on links already shared.
