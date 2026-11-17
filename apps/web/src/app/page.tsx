import { buttonVariants, Card } from "@bizora/ui";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PublicFooter } from "../components/public-footer";

/** Optional: a WhatsApp number for "Chat with us" (international digits, e.g. 2348012345678). */
const SUPPORT_WHATSAPP = process.env.NEXT_PUBLIC_SUPPORT_WHATSAPP?.replace(/\D/g, "") ?? "";

const FEATURES = ["sell", "collect", "stock", "staff", "bank", "capture"] as const;
const SCREENS = [
  { key: "sale", src: "/screens/sale.webp" },
  { key: "debtors", src: "/screens/debtors.webp" },
  { key: "home", src: "/screens/home.webp" },
] as const;

export default async function HomePage() {
  if ((await cookies()).get("bizora_session")?.value) redirect("/app");
  const t = await getTranslations("public");
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col px-4 py-10 sm:px-6 sm:py-16">
      <p className="text-sm font-semibold tracking-[0.12em] text-primary">{t("kicker")}</p>
      <h1 className="mt-3 max-w-3xl text-3xl font-semibold leading-tight sm:text-5xl">{t("title")}</h1>
      <p className="mt-4 max-w-2xl text-base text-muted sm:text-lg">{t("lead")}</p>
      <div className="mt-6 flex flex-wrap gap-3">
        <Link href="/register" className={buttonVariants({ size: "lg" })}>
          {t("create")}
        </Link>
        <Link href="/login" className={buttonVariants({ variant: "secondary", size: "lg" })}>
          {t("signIn")}
        </Link>
        {SUPPORT_WHATSAPP ? (
          <a href={`https://wa.me/${SUPPORT_WHATSAPP}?text=${encodeURIComponent(t("whatsappText"))}`} className={buttonVariants({ variant: "outline", size: "lg" })} rel="noreferrer" target="_blank">
            {t("whatsapp")}
          </a>
        ) : null}
      </div>
      <p className="mt-3 text-sm text-muted">{t("works")}</p>

      <section className="mt-10" aria-labelledby="features">
        <h2 id="features" className="sr-only">
          {t("featuresTitle")}
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((key) => (
            <Card key={key} className="p-5">
              <p className="text-base font-semibold">{t(`feature.${key}.title`)}</p>
              <p className="mt-2 text-sm text-muted">{t(`feature.${key}.body`)}</p>
            </Card>
          ))}
        </div>
      </section>

      <section className="mt-12" aria-labelledby="screens">
        <h2 id="screens" className="text-xl font-semibold">
          {t("screensTitle")}
        </h2>
        <div className="mt-4 grid gap-6 sm:grid-cols-3">
          {SCREENS.map((screen) => (
            <figure key={screen.key} className="space-y-2">
              {/* Plain, lazy images: the public page stays light (no tracking, no image service). */}
              <img src={screen.src} alt={t(`screen.${screen.key}.alt`)} width={360} height={720} loading="lazy" decoding="async" className="w-full rounded-card border border-border bg-card" />
              <figcaption className="text-sm text-muted">{t(`screen.${screen.key}.caption`)}</figcaption>
            </figure>
          ))}
        </div>
      </section>

      <p className="mt-12 max-w-2xl text-sm text-muted">{t("trust")}</p>
      <PublicFooter />
    </main>
  );
}
