# ADR-034: Shop locks, opening hours, permission to work late, and store-keeper approvals

## Status

Accepted on 19 Nov 2026 (Sprint 7h). From the owner's requests of 19 Nov.

## Context

The owner asked for:

- **Shop lock.** Owners can lock a shop at any time.
- **Opening and closing times.** Outside them only the owner can do anything in the books, unless the owner lets a staff member work for a certain period.
- **Store-keeper approvals.** A store keeper may change the state or count of goods, but a manager or owner must approve and complete each change. Releasing goods that are already paid for needs no approval.

## Decision

### Who is never stopped

- **The owner,** signed in as themselves (role OWNER, not on a shop device), is never stopped by a lock or by opening hours.
- **Everyone else** can still read: lists, reports and history stay open.

### Shop lock

- **Storage:** `branches.locked_at`, `locked_by` and `lock_note` (migration 0032).
- **Who:** only the owner locks or unlocks (`POST /branches/:id/lock` and `/unlock`), from Settings → Hours and locks. A note is optional, and staff see it.
- **What it stops:** any change by staff in that shop is refused with `SHOP_LOCKED` (HTTP 423). This includes a move into the shop from another one.
- **History:** `branch.locked` and `branch.unlocked` are recorded.

### Opening hours

- **Storage:** `businesses.opening_hours` (jsonb) holds an open and close time for each weekday, or null when that day is closed.
  - Null for the whole field means no hours, which is the default.
  - Times are in the business's time zone.
  - A close earlier than the open runs past midnight; the shared `isOpenAt` in contracts handles this and is unit-tested.
- **What it stops:** outside the hours, changes by staff are refused with `OUTSIDE_HOURS` (423). The message gives today's hours and says to ask the owner.
- **Who sets them:** the owner (`PUT /work-rules/hours`).

### Permission to work late

- **Storage:** `work_permits` holds the person, the start (now), the end (up to 14 days ahead), a note, and when it was stopped.
- **How it is given:** the owner picks a person and how many hours. The permission can be stopped early.
- **What it covers:** while the permission is active, opening hours do not stop that person. It does not open a locked shop.
- **History:** `work.permitted` and `work.permit_stopped` are recorded.

### How the rules are enforced

- **One global interceptor** (`WorkRulesInterceptor`) runs after sign-in and permission checks, and before anything else runs. It looks at every POST, PUT, PATCH and DELETE request.
- **Shops checked:**
  - the shop being worked in;
  - the person's own shop;
  - any `branchId`, `fromBranchId` or `toBranchId` in the request body.
- **Always allowed:**
  - signing in and out, and shop-device and PIN actions;
  - public links;
  - marking notifications read;
  - choosing a default shop;
  - accepting an invitation;
  - offline sync.
- **Offline sync:** work done with no network already happened, so it is accepted. If its time on the device falls in a lock or outside the hours:
  - it is recorded as `work.outside_rules`;
  - the owner gets a notification (`work.locked_offline` or `work.after_hours_offline`).

### Staff banner

- **What staff see:** a line at the top of every screen when their shop is locked, the business is closed, or they have permission to work late.
- **How it is built:** the banner is rendered on the server from `GET /work-rules/status`, so it adds no JavaScript to any screen. The quick sale stays at 169.6 KB.
- **Limits:** the banner is fetched when the app loads. Refused changes still explain themselves.

### Store-keeper approvals

- **Who must ask:** anyone without `stock.adjust` (the store keeper). Their stock changes become **requests** in `stock_requests` instead of moving stock:
  - stock in;
  - taking off or adding by hand;
  - moving to another shop;
  - sending goods back to a supplier.
- **Counts:** these already waited for approval and are unchanged.
- **Where requests come from:** the same rule applies to single actions, to lists (voice, photo or CSV), and to offline sync.
- **New for the store keeper:** they can now *ask* to take goods off or add them (`stock.adjust` accepts `stock.count`). Before this, they could not do it at all.
- **Checks when asking:**
  - the product, the shops and the supplier must exist;
  - there must be enough on the shelf for removals, moves and returns.
- **When a manager or owner decides:**
  - **Approve:** the change is completed as asked and checked again at that moment. The device's ID becomes the stock movement's ID.
  - **Reject:** needs a reason.
  - In both cases the person who asked is notified. Their notes and the decision show in the product's history.
- **Who approves:** managers and owners in that shop are notified (`stock.request`). They approve or reject from the Stock page, which also shows the store keeper their own requests.
- **Giving out paid goods** (`sales.release`) never waits.

## Consequences

- **Suppliers:** a store keeper's delivery creates the supplier and what is owed only when it is approved.
- **Managers and hours:** managers and administrators are stopped by opening hours like other staff. Only the owner works outside them, unless given permission.
- **Banner freshness:** a lock made while staff have the app open shows on their next page load. The API refuses their changes straight away either way.
- **Possible next steps:**
  - per-shop hours, if shops keep different times;
  - letting a manager give permission to work late, if owners ask for it.
