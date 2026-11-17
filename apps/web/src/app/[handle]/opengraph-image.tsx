import { ImageResponse } from "next/og";
import { shareCardColors as c, themeColor } from "@bizora/ui";
import { getTranslations } from "next-intl/server";
import { loadLogoDataUrl, loadProfile } from "../../lib/public-profile";

export const runtime = "nodejs";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * The picture WhatsApp and other apps show when a business's link is shared (ADR-024): its logo, name and colour,
 * with Bizora small. Used by the business page and, by inheritance, its receipt and statement links.
 * It never shows amounts, customers or anything from the receipt itself.
 */
export default async function BusinessCard({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const profile = await loadProfile(handle);
  const logo = profile?.hasLogo ? await loadLogoDataUrl(handle) : null;
  const t = await getTranslations("profile");
  const color = profile?.color ?? themeColor;
  const name = profile?.name ?? "Bizora";
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: c.background, fontFamily: "sans-serif" }}>
        <div style={{ height: 24, width: "100%", background: color, display: "flex" }} />
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 48, padding: "0 80px" }}>
          {logo ? (
            <img src={logo} alt="" width={220} height={220} style={{ objectFit: "contain", borderRadius: 24 }} />
          ) : (
            <div style={{ width: 220, height: 220, borderRadius: 48, background: color, color: c.onBrand, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 120, fontWeight: 700 }}>
              {name.slice(0, 1).toUpperCase()}
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
            <div style={{ fontSize: 72, fontWeight: 700, color: c.ink, lineHeight: 1.1 }}>{name}</div>
            {profile?.about ? <div style={{ fontSize: 32, color: c.muted, marginTop: 20, lineHeight: 1.3 }}>{profile.about.slice(0, 120)}</div> : null}
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", padding: "0 80px 40px", fontSize: 26, color: c.faint }}>{t("footer")}</div>
      </div>
    ),
    size,
  );
}
