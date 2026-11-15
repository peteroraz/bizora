import "fake-indexeddb/auto";
import type { SyncOperationResult } from "@bizora/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { backoffDelay, clearDevice, dismissRejected, enqueue, flush, OutboxNotEmptyError, type PushFn, summary } from "./outbox";

const chika = { tenantId: "t1", membershipId: "m-chika" };
const emeka = { tenantId: "t1", membershipId: "m-emeka" };

function recordingPush(decide: (id: string) => SyncOperationResult["status"] = () => "applied") {
  const calls: string[][] = [];
  const push: PushFn = async (operations) => {
    calls.push(operations.map((operation) => operation.id));
    return operations.map((operation) => {
      const status = decide(operation.id);
      return status === "rejected"
        ? { id: operation.id, status, error: { code: "VALIDATION_ERROR", message: "Name is required" } }
        : { id: operation.id, status, result: {} };
    });
  };
  return { push, calls };
}

beforeEach(async () => {
  // Empty the device between tests (nothing is pending at the end of each test).
  const pending = await summary();
  if (pending.devicePending === 0) await clearDevice();
});

describe("device outbox", () => {
  it("sends one person's work in the order it was done, then forgets it", async () => {
    const first = await enqueue(chika, "customer.create", { name: "A" }, { now: 1_000 });
    const second = await enqueue(chika, "customer.create", { name: "B" }, { now: 2_000 });
    expect((await summary(chika)).pending).toBe(2);
    const { push, calls } = recordingPush();
    const result = await flush(chika, push, 10_000);
    expect(calls).toEqual([[first, second]]);
    expect(result).toMatchObject({ sent: 2, applied: 2, failed: false });
    expect((await summary(chika)).pending).toBe(0);
  });

  it("never sends another staff member's work from a shared phone", async () => {
    await enqueue(chika, "customer.create", { name: "Chika's" });
    const emekas = await enqueue(emeka, "customer.create", { name: "Emeka's" });
    const { push, calls } = recordingPush();
    await flush(emeka, push);
    expect(calls).toEqual([[emekas]]);
    expect((await summary(chika)).pending).toBe(1);
    expect((await summary()).devicePending).toBe(1);
    await flush(chika, push);
    expect((await summary()).devicePending).toBe(0);
  });

  it("backs off after a network failure and keeps the order", async () => {
    await enqueue(chika, "customer.create", { name: "A" });
    let attempts = 0;
    const failing: PushFn = async () => {
      attempts += 1;
      throw new TypeError("Failed to fetch");
    };
    expect((await flush(chika, failing, 0)).failed).toBe(true);
    await enqueue(chika, "customer.create", { name: "B" });
    // Still backing off: nothing is sent, not even the newer item.
    const { push, calls } = recordingPush();
    await flush(chika, push, 1_000);
    expect(calls).toEqual([]);
    expect(attempts).toBe(1);
    // Coming back online forces a try, oldest first.
    await flush(chika, push, 1_000, { force: true });
    expect(calls[0]).toHaveLength(2);
    expect((await summary(chika)).pending).toBe(0);
  });

  it("keeps rejected work visible until it is dismissed, and never retries it", async () => {
    const bad = await enqueue(chika, "customer.create", { phone: "080" });
    const { push, calls } = recordingPush((id) => (id === bad ? "rejected" : "applied"));
    expect((await flush(chika, push)).rejected).toBe(1);
    const after = await summary(chika);
    expect(after.pending).toBe(0);
    expect(after.rejected.map((item) => item.error?.message)).toEqual(["Name is required"]);
    await flush(chika, push);
    expect(calls).toHaveLength(1);
    await dismissRejected(chika);
    expect((await summary(chika)).rejected).toEqual([]);
  });

  it("refuses to wipe the device while work is waiting", async () => {
    await enqueue(chika, "customer.create", { name: "Unsent" });
    await expect(clearDevice()).rejects.toBeInstanceOf(OutboxNotEmptyError);
    await flush(chika, recordingPush().push);
    await expect(clearDevice()).resolves.toBeUndefined();
  });

  it("waits longer after each failure, up to ten minutes", () => {
    const steady = () => 0.5;
    expect([1, 2, 3, 4].map((attempt) => backoffDelay(attempt, steady))).toEqual([5_000, 10_000, 20_000, 40_000]);
    expect(backoffDelay(20, steady)).toBe(600_000);
  });
});
