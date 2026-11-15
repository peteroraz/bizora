import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import en from "../../messages/en.json";
import ha from "../../messages/ha.json";
import ig from "../../messages/ig.json";
import pcm from "../../messages/pcm.json";
import yo from "../../messages/yo.json";
import { defaultLocale, isAppLocale, messageCatalogs, type AppLocale } from "./config";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeMessages(base: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const current = merged[key];
    if (isRecord(value) && isRecord(current)) merged[key] = mergeMessages(current, value);
    else if (value !== "" && value != null) merged[key] = value;
  }
  return merged;
}

const catalogs: Record<string, Record<string, unknown>> = {
  en: en as Record<string, unknown>,
  pcm: pcm as Record<string, unknown>,
  ha: ha as Record<string, unknown>,
  ig: ig as Record<string, unknown>,
  yo: yo as Record<string, unknown>,
};

export default getRequestConfig(async () => {
  const requested = (await cookies()).get("bizora_locale")?.value;
  const locale: AppLocale = requested && isAppLocale(requested) ? requested : defaultLocale;
  const catalog = messageCatalogs[locale];
  const english = catalogs.en ?? {};
  const extra = catalog === "en" ? {} : (catalogs[catalog] ?? {});
  return { locale, messages: mergeMessages(english, extra) };
});
