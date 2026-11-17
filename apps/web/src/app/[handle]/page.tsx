import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ShopHeading } from "../../components/shop-heading";
import { loadProfile } from "../../lib/public-profile";

type Params = { params: Promise<{ handle: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle } = await params;
  const profile = await loadProfile(handle);
  if (!profile) return { robots: { index: false, follow: false } };
  const description = profile.about ?? (await getTranslations("profile"))("defaultAbout", { business: profile.name });
  return {
    title: profile.name,
    description,
    // Pages are reached by the links a business shares; they are not listed in search engines.
    robots: { index: false, follow: false },
    openGraph: { title: profile.name, description, siteName: profile.name, type: "profile" },
  };
}

/** A business's own page (ADR-024): who they are and how to reach them. Every receipt and statement links here. */
export default async function BusinessProfilePage({ params }: Params) {
  const { handle } = await params;
  const profile = await loadProfile(handle);
  if (!profile) notFound();
  const t = await getTranslations("profile");
  return (
    <main className="mx-auto max-w-md space-y-6 p-6" data-testid="business-profile">
      <ShopHeading name={profile.name} address={profile.address} phone={profile.phone} logoSrc={profile.hasLogo ? `/api/v1/public/profiles/${profile.handle}/logo` : null} color={profile.color} />
      {profile.about ? <p className="whitespace-pre-line text-base">{profile.about}</p> : null}
      <p className="text-sm text-muted">{t("note", { business: profile.name })}</p>
      <p className="text-xs text-muted">
        {t("footer")}{" "}
        <a href="/" className="text-primary">
          {t("footerLink")}
        </a>
      </p>
    </main>
  );
}
