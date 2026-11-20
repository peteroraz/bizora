import { parseAmount, parseQuantity } from "@bizora/contracts";
import type { DraftLine } from "./jobs-client";

/** What the typed lines come to for the customer, before saving (the server works it out again). */
export function draftTotal(lines: DraftLine[], currency: string) {
  let total = 0n;
  for (const line of lines) {
    const price = line.price.trim() ? (parseAmount(line.price, currency) ?? 0n) : 0n;
    if (line.kind === "work") total += price;
    else if (line.kind === "part") total += (price * (parseQuantity(line.quantity || "1") ?? 1000n)) / 1000n;
    else if (line.kind === "bought") total += line.price.trim() ? price : line.cost.trim() ? (parseAmount(line.cost, currency) ?? 0n) : 0n;
  }
  return total;
}
