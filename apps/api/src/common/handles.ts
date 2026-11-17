import { handleFromName } from "@bizora/contracts";
import { eq } from "drizzle-orm";
import type { DbExecutor } from "../db/database.js";
import { organizations } from "../db/schema.js";

/**
 * A free link name for a new company (ADR-024): its own name when nobody has it, otherwise the name with a short
 * piece of the company id. The owner can change it later in Settings.
 */
export async function uniqueHandle(executor: DbExecutor, name: string, tenantId: string) {
  const wanted = handleFromName(name);
  const [taken] = await executor.select({ id: organizations.id }).from(organizations).where(eq(organizations.handle, wanted)).limit(1);
  return taken ? `${wanted.slice(0, 33).replace(/-+$/, "")}-${tenantId.replace(/-/g, "").slice(0, 6)}` : wanted;
}

/** A company's link name, for building its customer links: /<handle>/r/<token>. */
export async function handleOf(executor: DbExecutor, tenantId: string) {
  const [row] = await executor.select({ handle: organizations.handle }).from(organizations).where(eq(organizations.id, tenantId)).limit(1);
  return row?.handle ?? null;
}

/** Customer links carry the business's name (ADR-024); without one they fall back to the short form. */
export function customerPath(handle: string | null, kind: "r" | "s", token: string) {
  return handle ? `/${handle}/${kind}/${token}` : `/${kind}/${token}`;
}
