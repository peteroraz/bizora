# ADR-026: Staying signed in while working

## Status

Accepted on 18 Nov 2026 (Sprint 6f). The owner reported being signed out in the middle of work. Builds on the session design in Sprint 2.5 (refresh rotation with reuse detection) and on shop devices (Addendum v1.2 §6).

## Context

Signing in gives two cookies:

- a **short pass**: the access token, 15 minutes (`JWT_ACCESS_TTL`);
- a **long pass**: the refresh token, 7 days (`JWT_REFRESH_TTL`), or 12 hours on a shop device (`STAFF_SESSION_TTL`).

The web app never used the long pass, so 15 minutes after signing in, everyone was signed out, however busy they were. Three things made it worse:

1. **Background sync.** It sends waiting sales every 30 seconds. Its first refused request moved the whole page to sign-in, mid-sale, and threw the cart away.
2. **Any 401 counted as signed out.** A wrong current password on the change-password form also sent the person to sign-in.
3. **The renewal itself was fragile.**
   - The refresh endpoint was rate-limited by address, at 20 a minute. Renewals made by the web server all share the web server's address.
   - Rotation treated any second use of a token as theft and ended the sign-in on every device. Yet one browser does send the same token twice, when several requests find the pass expired at once.

## Decision

### Renew instead of signing out

- **Pages opened or reloaded** (`apps/web/src/middleware.ts`, for `/app/*` and `/select-workspace`): when the short pass is missing or ends within a minute and the long pass is there, the web server renews it before the page asks who is signed in.
  - The page being drawn sees the new pass straight away, and the browser keeps it for the requests that follow.
- **Requests from a screen** (`lib/api.ts`): a 401 with code `UNAUTHENTICATED` renews once and sends the request again.
  - Requests that arrive together share one renewal, and tabs take turns through a browser lock (`navigator.locks`).
  - Other 401s, such as a wrong password or a wrong PIN, stay on the page.
- **When renewal fails:** this happens after sign-out elsewhere, a week without use, or when a device is removed.
  - Owners go to sign-in with `returnTo`, and come back to the same screen.
  - Shop devices go to the staff list.
  - With no network, nothing moves.
- **Background calls** (`{ background: true }`, used by sync) never move the page. Waiting sales stay on the phone, and the next thing the person does will renew or sign in.

### Rotation keeps its theft check, with a 30-second grace

- **Duplicates within the grace:** a refresh token that was swapped less than 30 seconds ago (`REFRESH_REUSE_GRACE_MS`) and whose sign-in still has a live session gets a new session in the same sign-in (family) instead of ending it.
- **Anything later** is treated as stolen, as before, and ends the whole sign-in.
- **Signing out:** a revoked token is never accepted, even inside the grace.
  - Sign-out now ends the whole family, so a session made in the grace cannot outlive it.
  - "Sign out other devices" keeps the current family whole.
- **Accepted risk:** someone holding a copy of a refresh token and using it within 30 seconds of the real renewal gets in. They could have used it before the renewal anyway. This is the usual leeway in token rotation, and the theft check still applies outside that window.

### Smaller changes

- **No address rate limit on refresh.** A refresh token is a 256-bit random secret, so there is nothing to guess, and an address limit would have throttled every user at once.
- **Where you signed in from stays the first sign-in's.** Renewals keep the device and address of the first sign-in, not the web server's.
- **One row per sign-in on the account page.** It lists each sign-in once.

### Shop device auto-lock

- **Activity:** shop devices still lock after 5 minutes without use. Scrolling inside lists and sheets, typing and the mouse wheel now count as use. Before, only page-level scrolling did.
- **Warning:** 30 seconds before the lock, a bar says "This screen locks in 30 seconds". Any tap keeps the screen.

## Consequences

- Owners stay signed in for 7 days from their last use. Staff on a shop device stay signed in for 12 hours from their last use, and the 5-minute lock still applies.
- More rows in `sessions`, one per renewal, as before. Old rows are revoked; a clean-up job remains to be written.
- The shell loads offline sync and the product copy after the screen appears, to stay within the JavaScript budget.

## Alternatives considered

- **Longer short pass (for example, 12 hours).** Rejected: a stolen pass would work for hours, and revoking a device would take effect slowly.
- **Silent renewal on a timer.** Rejected as the only mechanism: phones pause timers when the screen is off, so the first request after waking would still fail. The retry covers it.
