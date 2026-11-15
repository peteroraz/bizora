export const locales = ["en-NG", "pcm", "ha", "ig", "yo"] as const;

export type AppLocale = (typeof locales)[number];

export const defaultLocale: AppLocale = "en-NG";

export const messageCatalogs = {
  "en-NG": "en",
  pcm: "pcm",
  ha: "ha",
  ig: "ig",
  yo: "yo",
} as const;

export function isAppLocale(value: string): value is AppLocale {
  return (locales as readonly string[]).includes(value);
}
