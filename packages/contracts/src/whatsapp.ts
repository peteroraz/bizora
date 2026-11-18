export function whatsAppHref(phoneE164: string, text: string): string {
  const digits = phoneE164.replace(/\D/g, "");
  const query = text.trim().length > 0 ? `?text=${encodeURIComponent(text)}` : "";
  return `https://wa.me/${digits}${query}`;
}
