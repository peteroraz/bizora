import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.fn();
vi.mock("../api", () => ({ api: (...args: unknown[]) => api(...args) }));

const { clearSavedLists, readCustomerDirectory, refreshCustomerDirectory } = await import("./customers");
const { enqueue, items } = await import("./outbox");

const cashier = { tenantId: "t1", membershipId: "m-cashier" };
const owner = { tenantId: "t1", membershipId: "m-owner" };
const reply = (body: unknown, ok = true) => ({ ok, json: async () => ({ data: body }) });

describe("customer names saved for offline voice", () => {
  beforeEach(() => api.mockReset());

  it("keeps names, IDs and credit only, separately for each person, and keeps the old list with no network", async () => {
    api.mockResolvedValueOnce(reply({ items: [{ id: "c1", name: "Emeka Obi", creditAllowed: true }], truncated: false, scope: "credit_and_recent" }));
    const saved = await refreshCustomerDirectory(cashier);
    expect(api).toHaveBeenCalledWith("/api/v1/customers/directory", {}, { background: true });
    expect(saved?.items).toEqual([{ id: "c1", name: "Emeka Obi", creditAllowed: true }]);
    expect(saved?.scope).toBe("credit_and_recent");
    // The owner of the same business has their own list; the cashier's is not shown to them.
    expect(await readCustomerDirectory(owner)).toBeNull();

    // No network: the saved list stays.
    api.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect((await refreshCustomerDirectory(cashier))?.items).toHaveLength(1);
    // Signed out on the server: the saved list stays too, until sign-out clears it here.
    api.mockResolvedValueOnce(reply(null, false));
    expect((await refreshCustomerDirectory(cashier))?.items).toHaveLength(1);
  });

  it("sign-out clears saved names but keeps sales waiting to sync", async () => {
    api.mockResolvedValueOnce(reply({ items: [{ id: "c1", name: "Emeka Obi", creditAllowed: true }], truncated: false, scope: "all" }));
    await refreshCustomerDirectory(owner);
    await enqueue(owner, "sale.create", { id: "s1" }, { meta: { summary: "Rice 50kg ×5", totalMinor: "37500000", currency: "NGN", customerName: "Emeka Obi", source: "voice", number: "DEV1-000001" } });
    await clearSavedLists();
    expect(await readCustomerDirectory(owner)).toBeNull();
    const waiting = await items(owner, "sale.create");
    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.meta?.source).toBe("voice");
  });
});
