import { z } from "zod";
import { FLEXIBLE_UNIT } from "./stock-units.js";

const minor = z.string().trim().regex(/^\d{1,15}$/, "Enter a whole amount in the smallest unit of the currency (kobo, cents, pesewas).");
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-01.");
const NAME_HEADER = /^(products?|names?|items?)$/i;

/**
 * Names from a pasted list or a one-column file (ADR-049). A heading such as "Product" is skipped.
 * A comma-separated line keeps the first cell, so a price column is ignored.
 */
export function namesFromText(text: string) {
  const names: string[] = [];
  let first = true;
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.includes(",")) line = (line.split(",")[0] ?? "").replace(/^"|"$/g, "").trim();
    line = line.replace(/^[-*•]\s*/, "").replace(/^\d+[.)]\s*/, "").trim();
    if (!line) continue;
    if (first && NAME_HEADER.test(line)) {
      first = false;
      continue;
    }
    first = false;
    names.push(line);
  }
  return names;
}

/** Preview or add a list of product names. Nothing is saved while dryRun is left on. */
export const quickImportSchema = z
  .object({
    dryRun: z.boolean().optional(),
    text: z.string().max(200_000).optional(),
    names: z.array(z.string().max(200)).max(2000).optional(),
  })
  .refine((value) => Boolean(value.text?.trim()) || Boolean(value.names?.length), { message: "Add at least one name." });

export const savedItemRenameSchema = z.object({
  name: z.string().trim().min(1).max(160),
});

export const itemAliasSchema = z.object({
  alias: z.string().trim().min(1).max(160),
});

export const quickMergeSchema = z.object({
  keepId: z.string().uuid(),
  dropId: z.string().uuid(),
});

/** Turn a remembered item into a product. Stock starts only from a quantity the owner types, never from past sales. */
export const quickUpgradeSchema = z.object({
  trackStock: z.boolean().optional(),
  priceMinor: minor.optional(),
  costMinor: minor.optional(),
  category: z.string().trim().max(60).optional(),
  sku: z.string().trim().max(64).optional(),
  barcode: z.string().trim().max(64).optional(),
  openingQuantity: z.string().trim().optional(),
  openingCostMinor: minor.optional(),
});

export const businessUnitSchema = z.object({
  code: z.string().trim().toLowerCase().regex(FLEXIBLE_UNIT, "Use a short unit such as cup or mudu."),
  displayName: z.string().trim().min(1).max(40),
  pluralName: z.string().trim().max(40).optional(),
});

export const businessUnitPatchSchema = z.object({
  displayName: z.string().trim().min(1).max(40).optional(),
  pluralName: z.string().trim().max(40).optional(),
  active: z.boolean().optional(),
});

/** A cost added later for a period. It is labelled as an estimate and does not change the sale. */
export const costEstimateSchema = z
  .object({
    estimatedCostMinor: minor,
    periodStart: day,
    periodEnd: day,
    reason: z.string().trim().min(1).max(240),
  })
  .refine((value) => value.periodEnd >= value.periodStart, { message: "The end date is before the start.", path: ["periodEnd"] });
