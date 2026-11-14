import { z } from "zod";

export const passwordRules = [
  {
    id: "min-length",
    label: "At least 12 characters",
    met: (value: string) => value.length >= 12,
  },
  {
    id: "max-length",
    label: "At most 128 characters",
    met: (value: string) => value.length <= 128,
  },
] as const;

export const passwordSchema = z.string().superRefine((value, ctx) => {
  for (const rule of passwordRules) {
    if (!rule.met(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: rule.label });
    }
  }
});
