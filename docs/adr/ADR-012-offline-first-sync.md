# ADR-012: Offline-first operation and sync

## Status

Accepted. Implements Spec Addendum v1.2 §7. Foundation built in Sprint 3C.5b; Sprints 4 and 5 add stock and sales operations on top.

## Context

Shops lose network often. The addendum requires these to keep working offline and sync later:
- recording a sale;
- looking up and creating customers;
- looking up products and stock (last synced);
- recording stock in and stock counts.

Online payment links, user and role administration, large reports and settings stay online-only.

Offline-capable work must never be applied twice, never overwrite money or stock, never leak between organizations, and never be credited to the wrong staff member on a shared phone.

## Decision

### 1. Client-generated IDs (UUIDv7)

- Records that can be created offline get their ID on the device: a UUIDv7 (RFC 9562), from `uuidv7()` in `@bizora/contracts`.
- UUIDv7 is time-ordered, so outbox items sort in the order the work was done, and IDs index well.
- The server accepts a client ID only if it is a UUIDv7.
  - If the same organization sends an ID it already holds, it gets that record back. A device that lost the response can safely send again.
  - An ID held by another organization is refused with `ID_CONFLICT`, without saying whose record it is.

### 2. Idempotent writes

- Every offline-capable write carries an `Idempotency-Key` header. `@Idempotent()` on a route enables it, and `@Idempotent({ required: true })` refuses requests without one.
- Keys are stored per organization in `idempotency_keys`, with:
  - the route (`scope`),
  - a SHA-256 of the request,
  - the membership that sent it,
  - the stored response.
- A retry with the same key and the same request returns the stored response, marked `Idempotent-Replayed: true`. That includes a stored 4xx refusal (validation, duplicate phone, permission), so a retry is refused the same way.
- The same key with a different request, a different route or a different person returns `422 IDEMPOTENCY_KEY_REUSED`. A request still running returns `409 IDEMPOTENCY_IN_PROGRESS`.
- A server error (5xx) frees the key so the device can retry. A claim left "in progress" for over 60 seconds (crashed request) can be taken over by the same sender with the same request.
- Keys can be pruned after 30 days (`IdempotencyService.prune`); devices retry for far less than that. No scheduled job runs this yet.

### 3. Sync push

- `POST /api/v1/sync/push` takes up to 50 operations `{ id, type, occurredAt, payload }`.
- The operation `id` (UUIDv7) is its idempotency key, scoped `sync:<type>`.
- Operations are applied in the order sent. Each result is `applied`, `duplicate` (already applied; returns the first result) or `rejected` (with a code and plain message). Rejections are final: the device shows them and never retries them.
- An unexpected server error stops the batch, so later operations never overtake earlier ones. The device retries the rest.
- Every operation is checked against the sender's permissions and scope, exactly as the equivalent normal request would be. Modules register handlers in `SyncHandlerRegistry` (`customer.create` today; stock and sales operations in Sprints 4 and 5).
- Devices never write ledger entries. Postings happen on the server when an operation is applied (ADR-013).

### 4. Document numbers

- Devices issue provisional numbers: `DEV<device number>-<sequence>`, for example `DEV3-000045`. Device numbers (`shop_devices.code`) are unique per organization and assigned at enrolment.
  - This differs from the addendum's example `B12-DEV3-000045`: a device belongs to exactly one shop, so the device number alone is unambiguous, and branches have no short code yet.
- The server issues the official number on sync, per business and document type: `R-000123` (receipt), `INV-`, `PAY-`, `SI-`, `SC-`, `TR-`, `EXP-`. This is done by `DocumentNumberService.next()` inside the saving transaction. Numbers come from an upsert that takes a row lock, so concurrent sales get distinct numbers, and a rolled-back transaction does not use one up.
- Receipts show both numbers when they differ.

### 5. Device store and outbox

- IndexedDB database `bizora-offline`, store `outbox` (`apps/web/src/lib/offline/outbox.ts`).
- Background sync runs:
  - when the browser comes back online (immediately, ignoring any backoff),
  - when the app returns to the foreground,
  - every 30 seconds.
- After a network failure it backs off exponentially: 5 s, 10 s, 20 s … up to 10 minutes, with ±20% jitter. Newer items wait behind older ones.
- The header shows "N changes waiting to sync". Rejected items are listed with their message until dismissed.
- The server is the authority. Editable records use last-writer-wins with an audit trail. Money and stock are append-only (see 6).

### 6. Stock is an append-only ledger of movements (Sprint 4)

- Received, sold, adjusted and transferred quantities are rows; on-hand quantity is derived.
- Offline movements from several devices merge without overwriting.
- Negative stock after sync is allowed but flagged for owner review, never silently corrected.
- Weighted-average costing is in ADR-013.

### 7. Shared devices

- Outbox items belong to the person who made them (organization + membership). Only that person's items are sent while they are signed in, because the server attributes work to the session, never to a name in the payload. When Chika locks the phone and Emeka signs in, Chika's waiting work stays queued until she signs in again.
- Locking returns to the PIN screen, which hides all data.
- Turning off Shop mode is refused while anything is waiting to sync. Once everything has synced, it deletes the device store.
- Only what the branch needs is cached. Reference data caching (products, stock levels, customers for staff with `customers.read`) arrives with Sprint 4. A cashier's counter lookup is never cached on the device (data minimisation, ADR-011).

### 8. Tenant isolation

- Sync and idempotency are scoped to the organization from the session, never from the payload.
- Tests cover:
  - another organization replaying an operation or a customer ID;
  - another person reusing a key;
  - a cashier pushing a customer create (refused by permission).

## Consequences

- Each new offline-capable feature needs a sync handler, a client ID and an outbox call. The rules above apply unchanged.
- The device store is per browser. Clearing site data loses unsynced work, which is why the waiting count is always visible.
- Pull sync (downloading reference data for offline lookups) is designed but not built. It comes with Products in Sprint 4.
