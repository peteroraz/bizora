import { z } from "zod";
import { parseQuantity } from "./stock-units.js";

const quantityOrZero = z
  .string()
  .trim()
  .refine((value) => value === "0" || parseQuantity(value) !== null, "Enter a quantity, with up to 3 decimals.");
const positiveQuantity = z.string().trim().refine((value) => parseQuantity(value) !== null, "Enter a quantity above zero, with up to 3 decimals.");

/** Thousandths of the base unit, for comparing what was entered. */
const thousandths = (value: string | null | undefined) => (value === undefined || value === null ? null : value === "0" ? 0n : parseQuantity(value));

/**
 * A reorder rule (ADR-063), in the product's base unit. Without `branchId` it is for every shop, and its reorder
 * point is the product's low stock level. Each part except the reorder point is optional.
 */
export const reorderRuleSchema = z
  .object({
    branchId: z.string().uuid().nullable().optional(),
    reorderPoint: quantityOrZero,
    minQuantity: quantityOrZero.nullable().optional(),
    targetQuantity: positiveQuantity.nullable().optional(),
    maxQuantity: positiveQuantity.nullable().optional(),
    leadTimeDays: z.number().int().min(0).max(365).nullable().optional(),
    preferredSupplierId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const point = thousandths(value.reorderPoint) ?? 0n;
    const min = thousandths(value.minQuantity);
    const target = thousandths(value.targetQuantity);
    const max = thousandths(value.maxQuantity);
    if (min !== null && min > point) context.addIssue({ code: "custom", path: ["minQuantity"], message: "The minimum cannot be more than the reorder point." });
    if (target !== null && target <= point) context.addIssue({ code: "custom", path: ["targetQuantity"], message: "Fill up to more than the reorder point." });
    if (max !== null && target !== null && max < target) context.addIssue({ code: "custom", path: ["maxQuantity"], message: "The most to keep cannot be less than what you fill up to." });
    if (max !== null && max <= point) context.addIssue({ code: "custom", path: ["maxQuantity"], message: "The most to keep must be more than the reorder point." });
  });
export type ReorderRuleInput = z.infer<typeof reorderRuleSchema>;
