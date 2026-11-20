import { TERMS_VERSION } from "@bizora/contracts";
import { getTranslations } from "next-intl/server";
import { PublicFooter } from "../../components/public-footer";

type Section = { id: string; title: string; paragraphs: string[] };

/** The Terms of use every owner accepts (ADR-039). Section 5 covers when Bizora staff can see a business. */
export default async function TermsPage() {
  const t = await getTranslations("legal");
  const sections = t.raw("termsSections") as Section[];
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col px-4 py-10">
      <p className="text-sm font-semibold text-primary">{t("draft")}</p>
      <h1 className="mt-2 text-3xl font-semibold">{t("termsTitle")}</h1>
      <p className="mt-2 text-sm text-muted">{t("termsVersion", { version: TERMS_VERSION })}</p>
      <nav aria-label={t("termsContents")} className="mt-6 rounded-card border border-border p-4 text-sm">
        <p className="font-medium">{t("termsContents")}</p>
        <ul className="mt-2 grid gap-1 sm:grid-cols-2">
          {sections.map((section) => (
            <li key={section.id}>
              <a href={`#${section.id}`} className="text-primary underline-offset-2 hover:underline">
                {section.title}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="mt-8 space-y-8 text-sm leading-6">
        {sections.map((section) => (
          <section key={section.id} id={section.id} className="scroll-mt-6 space-y-3">
            <h2 className="text-lg font-semibold">{section.title}</h2>
            {section.paragraphs.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </section>
        ))}
      </div>
      <PublicFooter />
    </main>
  );
}
