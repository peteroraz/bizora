import { getRequestConfig } from "next-intl/server";
import en from "../../messages/en.json";

// Bizora staff work in English; the portal has one catalog.
export default getRequestConfig(async () => ({ locale: "en", messages: en as Record<string, unknown> }));
