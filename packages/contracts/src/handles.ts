import { z } from "zod";

/**
 * A business's link name (ADR-024): bizora.app/ada-stores, bizora.app/ada-stores/r/… for its receipts.
 * Lowercase letters, numbers and single dashes, 3–40 characters, not starting or ending with a dash.
 */
export const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,39}$/;

/** First path parts Bizora uses or may use itself; no business may take them. */
export const RESERVED_HANDLES = new Set([
  "about", "account", "admin", "api", "app", "apps", "assets", "auth", "billing", "blog", "bizora", "business", "careers",
  "contact", "dashboard", "docs", "download", "favicon", "features", "health", "help", "home", "icon", "invite", "invoice",
  "invoices", "join", "legal", "login", "logout", "manifest", "news", "offline", "pay", "payment", "payments", "press",
  "pricing", "privacy", "providers", "r", "ready", "receipt", "receipts", "register", "reset", "robots", "s", "screens", "security",
  "select-workspace", "settings", "shop", "signin", "signup", "sitemap", "statement", "statements", "status", "store",
  "support", "sw", "team", "terms", "verify", "welcome", "www", "zora",
]);

export function isReservedHandle(handle: string) {
  return RESERVED_HANDLES.has(handle) || handle.startsWith("_") || handle.startsWith("api-") || handle.startsWith("bizora-");
}

/** A first suggestion from a business name: "Ada's Stores & Co." → "adas-stores-co". */
export function handleFromName(name: string) {
  const base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36)
    .replace(/-+$/g, "");
  const padded = base.length >= 3 ? base : `${base || "my"}-shop`.replace(/^-/, "");
  return isReservedHandle(padded) ? `${padded}-shop` : padded;
}

export const handleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(HANDLE_PATTERN, "Use 3 to 40 letters, numbers or dashes, like ada-stores.")
  .refine((value) => !isReservedHandle(value), "That name is kept for Bizora. Try another.");

export const updatePublicProfileSchema = z.object({
  handle: handleSchema.optional(),
  /** One line about the business, shown on its public page. */
  about: z
    .string()
    .max(560)
    .transform((value) => value.replace(/\s+/g, " ").trim())
    .refine((value) => value.length <= 280, "Keep it to 280 characters or fewer.")
    .nullable()
    .optional(),
});
export type UpdatePublicProfileInput = z.infer<typeof updatePublicProfileSchema>;
