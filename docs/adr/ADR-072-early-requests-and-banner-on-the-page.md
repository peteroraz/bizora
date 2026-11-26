# ADR-072: Start a screen's first requests from its HTML; draw the email banner with the page

## Status

Accepted on 26 Nov 2026.

## Context

The loading-speed budget (Largest Contentful Paint ≤ 2.5 s on Lighthouse's "Slow 4G" with a 4× slower CPU, checked in CI) sat at 2.3–2.5 s on Home, Customers and Stock for weeks, so CI failed now and then with no code change.

Measured on main:

- These screens show their first text at about 0.9 s, but their scripts take until about 2.2 s to download and start.
- Only then did each screen ask the server for its list or figures, so the content (the largest paint) came one round trip later, at 2.4–2.6 s.
- On Home the largest element was the "Verify your email" banner. It waited for scripts because the "hide for a week" choice lived in the phone's storage.
- The Quick sale already drew its main text with the page, at 0.8 s.

## Decision

1. **Early requests.**
    - `lib/early-requests.ts` lists, per screen, the plain GET requests it always makes when opened: Home (profile, dashboard, notifications), Customers (first page, notifications), Stock (first page, expiring stock, notifications).
    - The app layout puts a few lines of script in the page, carrying the page's CSP nonce (ADR-036). They start those requests while the screen's scripts download. Sign-in rides on the cookie as usual.
    - `api()` uses an early answer for a plain GET with the same address, once, if it is under 10 seconds old. Anything else is fetched as before: a request with a method, body or headers, a second request, a screen opened with a search in its address, or an early request that failed.
    - An expired sign-in is handled as for any request: renewed, then asked again normally.
    - Only the first visit to a screen benefits. Moving between screens inside the app has nothing to wait for.
2. **The email banner is drawn with the page.**
    - "Hide for a week" sets a cookie (`bizora_verify_banner_hidden`, 7 days) instead of browser storage.
    - The layout reads it, so the page arrives with the banner or without it.
    - A choice kept the old way is honoured once and moved to the cookie.
3. **Home asks for the profile and the dashboard together**, not one after the other.

## Results

Measured locally with the same throttling as the CI budget test:

| Screen | Before | After |
| --- | --- | --- |
| Home | 2,584 ms | 1,048 ms |
| Customers | 2,420 ms | 2,280 ms |
| Stock | 2,500 ms | 2,412 ms |

Customers and Stock now show their content as soon as their scripts start; their data has arrived by about 1.2 s. What is left for them is the time to download and start the scripts. Making them faster still means less script or drawing the list on the server, which is not done here.

## Consequences

- A screen in the list may make a request it would not have made for a person without permission to see it. It gets "not allowed", which is ignored, as the screen's own request would be.
- A new screen gains nothing until it is added to the list, and the address must match exactly. A wrong entry only wastes one request: the screen asks as usual.
- Tests:
    - `src/lib/early-requests.test.ts`: which screens start what, no errors offline, once only, too old, safe in HTML.
    - `e2e/early-requests.e2e.ts`: the list is asked for once and before the page has loaded; the banner is in the page as sent; hiding lasts across visits. These checks fail on the code before this change.
