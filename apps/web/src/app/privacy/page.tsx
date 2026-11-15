import { getTranslations } from "next-intl/server";
import { PublicFooter } from "../../components/public-footer";

export default async function PrivacyPage() {
  const t = await getTranslations("legal");
  const paragraphs = t.raw("privacy") as string[];
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col px-4 py-10">
      <p className="text-sm font-semibold text-primary">{t("draft")}</p>
      <h1 className="mt-2 text-3xl font-semibold">{t("privacyTitle")}</h1>
      <div className="mt-6 space-y-4 text-sm leading-6">
        {paragraphs.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
      </div>
      <PublicFooter />
    </main>
  );
}
