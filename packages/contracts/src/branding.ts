import { z } from "zod";

/** Company branding on documents (ADR-021). Logos are stored in the database, so they stay small. */
export const LOGO_MAX_BYTES = 512 * 1024;
export const LOGO_MIN_SIDE = 16;
export const LOGO_MAX_SIDE = 2000;
/** The app shrinks a picked logo to this many pixels on its longest side before uploading. */
export const LOGO_UPLOAD_SIDE = 600;
export const LOGO_TYPES = ["image/png", "image/jpeg"] as const;
export type LogoType = (typeof LOGO_TYPES)[number];

export const BRAND_TEXT_LIMITS = { receiptMessage: 300, invoiceMessage: 500, documentTerms: 1000 } as const;
const MAX_LINES = 12;

/** WCAG contrast of a #RRGGBB colour against white paper. */
export function contrastWithWhite(hex: string): number {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return 1.05 / (luminance + 0.05);
}

/** The colour every company starts with (organizations.primary_color default). */
export const BRAND_DEFAULT_COLOR = "#1D4ED8";

/** Colours lighter than this cannot be read as headings on a white receipt. */
export const BRAND_MIN_CONTRAST = 3;

export const brandColorSchema = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/, "Use a 6-digit colour like #1D4ED8.")
  .refine((value) => contrastWithWhite(value) >= BRAND_MIN_CONTRAST, "This colour is too light to read on white paper. Choose a darker one.");

/** Text the owner writes for customers: plain text, kept tidy. Empty means none. */
export function cleanBrandText(text: string): string {
  const printable = Array.from(text.replace(/\r\n?/g, "\n"))
    .filter((character) => {
      const code = character.charCodeAt(0);
      // Keep new lines and tabs (tabs become spaces below); drop other control characters.
      return code === 10 || code === 9 || (code >= 32 && code !== 127);
    })
    .join("");
  return printable
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function brandText(max: number) {
  return z
    .string()
    .max(max * 2)
    .transform(cleanBrandText)
    .refine((value) => value.length <= max, `Keep it to ${max} characters or fewer.`)
    .refine((value) => value.split("\n").length <= MAX_LINES, `Keep it to ${MAX_LINES} lines or fewer.`)
    .nullable()
    .optional();
}

export const updateBrandingSchema = z.object({
  primaryColor: brandColorSchema.optional(),
  accentColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Use a 6-digit colour like #0F172A.").optional(),
  receiptMessage: brandText(BRAND_TEXT_LIMITS.receiptMessage),
  invoiceMessage: brandText(BRAND_TEXT_LIMITS.invoiceMessage),
  documentTerms: brandText(BRAND_TEXT_LIMITS.documentTerms),
});
export type UpdateBrandingInput = z.infer<typeof updateBrandingSchema>;

export const logoUploadSchema = z.object({
  contentType: z.enum(LOGO_TYPES),
  // Base64 of at most LOGO_MAX_BYTES.
  dataBase64: z.string().min(16).max(Math.ceil(LOGO_MAX_BYTES / 3) * 4 + 4),
});
export type LogoUploadInput = z.infer<typeof logoUploadSchema>;

export type BrandingView = {
  /** The business's link name (ADR-024) and its one line about itself. */
  handle?: string;
  about?: string | null;
  primaryColor: string;
  receiptMessage: string | null;
  invoiceMessage: string | null;
  documentTerms: string | null;
  logo: { version: string; contentType: LogoType; width: number; height: number; byteSize: number } | null;
};
