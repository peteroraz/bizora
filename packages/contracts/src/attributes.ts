import { z } from "zod";

/** Product attributes (ADR-060): defined per business, chosen per variant, used to make variants. */
export const ATTRIBUTE_KINDS = ["select", "multi_select", "text", "number", "boolean"] as const;
export type AttributeKind = (typeof ATTRIBUTE_KINDS)[number];

/** The most variants one "make variants" run may create. */
export const VARIANT_GENERATION_MAX = 100;

const name = z.string().trim().min(1, "Name the attribute, such as Colour or Size.").max(60);
const optionValue = z.string().trim().min(1).max(60);

export const attributeCreateSchema = z
  .object({
    name,
    kind: z.enum(ATTRIBUTE_KINDS).default("select"),
    /** For a number: what it is measured in, such as GB or kg. */
    unit: z.string().trim().max(16).optional().nullable(),
    /** For select and multi-select: the choices, such as Red, Black. */
    options: z.array(optionValue).max(200).optional(),
    position: z.number().int().min(0).max(10_000).optional(),
  })
  .refine((value) => !["text", "number", "boolean"].includes(value.kind) || !value.options?.length, { message: "Only a list attribute has choices.", path: ["options"] });

export const attributeUpdateSchema = z.object({
  name: name.optional(),
  unit: z.string().trim().max(16).optional().nullable(),
  active: z.boolean().optional(),
  position: z.number().int().min(0).max(10_000).optional(),
  /** Choices to add to a list attribute. Existing ones stay. */
  addOptions: z.array(optionValue).max(200).optional(),
});

/** One attribute's value on a variant. Exactly one kind of value, matching the attribute. */
export const variantAttributeValueSchema = z.object({
  attributeId: z.string().uuid(),
  optionIds: z.array(z.string().uuid()).max(50).optional(),
  text: z.string().trim().min(1).max(120).optional(),
  number: z.string().trim().regex(/^-?\d{1,14}(\.\d{1,4})?$/, "Enter a number, like 128 or 1.5.").optional(),
  boolean: z.boolean().optional(),
});

export const variantAttributesSchema = z.object({
  /** Attributes listed here are set to these values; an attribute with no value given is cleared. */
  values: z.array(variantAttributeValueSchema).max(50),
});

/** Make one variant for each combination of the chosen options ("Red, Black" × "S, M, L" = 6). */
export const generateVariantsSchema = z.object({
  attributes: z
    .array(z.object({ attributeId: z.string().uuid(), optionIds: z.array(z.string().uuid()).min(1).max(50) }))
    .min(1)
    .max(4),
  baseUnit: z.string().trim().min(1).max(16).optional(),
  /** The everyday price for every new variant; each can be changed after. */
  priceMinor: z.string().trim().regex(/^\d{1,15}$/).optional().nullable(),
  /** Only work out what would be made. */
  dryRun: z.boolean().optional(),
});

/** All combinations, in order: the first attribute changes slowest. */
export function combinations<T>(lists: T[][]): T[][] {
  return lists.reduce<T[][]>((all, list) => all.flatMap((prefix) => list.map((item) => [...prefix, item])), [[]]);
}
