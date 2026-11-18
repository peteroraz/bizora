import { cookies, headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PublicFooter } from "../components/public-footer";
import { formatCurrency } from "../i18n/format";
import { SAMPLE_RECEIPTS } from "../lib/landing-samples";
import "./landing.css";

/** Optional: a WhatsApp number for "Chat with us" (international digits, e.g. 447700900123). */
const SUPPORT_WHATSAPP = process.env.NEXT_PUBLIC_SUPPORT_WHATSAPP?.replace(/\D/g, "") ?? "";

const FEATURES = [
  { key: "sell", src: "/screens/sale.webp" },
  { key: "collect", src: "/screens/debtors.webp" },
  { key: "home", src: "/screens/home.webp" },
] as const;
const STEPS = ["create", "products", "sell"] as const;
const QUESTIONS = ["internet", "phones", "staff", "currency", "data"] as const;

/** The public homepage (ADR-025): for any kind of business, anywhere. */
export default async function HomePage() {
  if ((await cookies()).get("bizora_session")?.value) redirect("/app");
  const t = await getTranslations("public");
  const host = (await headers()).get("x-forwarded-host") ?? (await headers()).get("host") ?? "bizora.app";

  return (
    <div className="min-h-screen bg-canvas text-fg">
      <section className="bg-[var(--landing-ink)] text-[var(--landing-on-ink)]">
        <nav className="mx-auto flex max-w-6xl items-center justify-between px-5 pt-6 sm:px-8" aria-label={t("navLabel")}>
          <span className="text-lg font-semibold tracking-tight">{t("brand")}</span>
          <Link href="/login" className="inline-flex min-h-11 items-center px-2 text-sm font-medium text-[var(--landing-on-ink-muted)] hover:text-[var(--landing-on-ink)]">
            {t("signIn")}
          </Link>
        </nav>
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 pb-16 pt-12 sm:px-8 lg:grid-cols-[1.15fr_1fr] lg:pb-24 lg:pt-20">
          <div>
            <h1 className="max-w-xl text-[2.6rem] font-semibold leading-[1.02] tracking-[-0.035em] sm:text-6xl lg:text-7xl">{t("title")}</h1>
            <p className="mt-6 max-w-lg text-lg leading-relaxed text-[var(--landing-on-ink-muted)]">{t("lead")}</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/register" className="inline-flex h-12 items-center rounded-control bg-[var(--landing-on-ink)] px-6 text-base font-semibold text-[var(--landing-ink)] hover:bg-[var(--landing-paper)]">
                {t("create")}
              </Link>
              {SUPPORT_WHATSAPP ? (
                <a
                  href={`https://wa.me/${SUPPORT_WHATSAPP}?text=${encodeURIComponent(t("whatsappText"))}`}
                  className="inline-flex h-12 items-center rounded-control border border-[var(--landing-on-ink-muted)] px-6 text-base font-medium"
                  rel="noreferrer"
                  target="_blank"
                >
                  {t("whatsapp")}
                </a>
              ) : null}
            </div>
            <p className="mt-4 text-sm text-[var(--landing-on-ink-muted)]">{t("works")}</p>
          </div>

          <div className="receipt-stage" role="img" aria-label={t("receiptAlt")}>
            {SAMPLE_RECEIPTS.map((sample, slot) => {
              const total = sample.lines.reduce((sum, line) => sum + line.amountMinor, 0n);
              const money = (minor: bigint) => formatCurrency(minor, sample.currency, sample.locale);
              return (
                <div key={sample.handle} className="receipt font-mono text-[13px] leading-relaxed" style={{ ["--slot" as string]: slot }} aria-hidden="true">
                  <p className="text-center font-sans text-base font-semibold">{sample.business}</p>
                  <p className="text-center text-[var(--landing-paper-faint)]">
                    {sample.place} · {sample.number}
                  </p>
                  <div className="my-3 border-t border-dashed border-[var(--landing-paper-faint)]" />
                  {sample.lines.map((line) => (
                    <div key={line.item} className="flex justify-between gap-3">
                      <span>
                        {line.quantity} × {line.item}
                      </span>
                      <span className="shrink-0 tabular-nums">{money(line.amountMinor)}</span>
                    </div>
                  ))}
                  <div className="my-3 border-t border-dashed border-[var(--landing-paper-faint)]" />
                  <div className="flex justify-between text-base font-bold">
                    <span>{t("receiptTotal")}</span>
                    <span className="tabular-nums">{money(total)}</span>
                  </div>
                  <p className="mt-1 text-[var(--landing-paper-faint)]">{t(`receiptPaid.${sample.method}`)}</p>
                  <p className="mt-6 text-center text-[var(--landing-paper-faint)]">{t("receiptSent")}</p>
                  <p className="text-center font-medium">
                    {host}/{sample.handle}
                  </p>
                  <span className="receipt-stamp font-sans">{t("paid")}</span>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl space-y-20 px-5 py-20 sm:px-8 lg:space-y-28 lg:py-28" aria-label={t("featuresTitle")}>
        {FEATURES.map((feature, index) => (
          <div key={feature.key} className={`grid items-center gap-10 lg:grid-cols-2 ${index % 2 === 1 ? "lg:[&>figure]:order-first" : ""}`}>
            <div className="max-w-md">
              <h2 className="text-3xl font-semibold leading-tight tracking-[-0.02em] sm:text-4xl">{t(`feature.${feature.key}.title`)}</h2>
              <p className="mt-4 text-lg leading-relaxed text-muted">{t(`feature.${feature.key}.body`)}</p>
            </div>
            <figure className="mx-auto w-full max-w-[17rem]">
              {/* A plain phone outline around a real screen of the app; lazy, so the page stays light. */}
              <div className="rounded-[2.25rem] border-[10px] border-[var(--landing-ink)] bg-[var(--landing-ink)] shadow-xl">
                <img src={feature.src} alt={t(`feature.${feature.key}.alt`)} width={360} height={720} loading="lazy" decoding="async" className="block w-full rounded-[1.6rem]" />
              </div>
            </figure>
          </div>
        ))}

        <div className="grid items-center gap-10 lg:grid-cols-2">
          <div className="max-w-md">
            <h2 className="text-3xl font-semibold leading-tight tracking-[-0.02em] sm:text-4xl">{t("feature.link.title")}</h2>
            <p className="mt-4 text-lg leading-relaxed text-muted">{t("feature.link.body")}</p>
          </div>
          <div className="mx-auto w-full max-w-sm rounded-card border border-border bg-card p-4 shadow-sm">
            <p className="truncate rounded-control bg-canvas px-3 py-2 text-sm text-muted">
              {host}/<span className="font-semibold text-fg">{t("feature.link.sampleName")}</span>{t("feature.link.sampleRest")}
            </p>
            <p className="mt-4 text-lg font-semibold">{t("feature.link.cardTitle")}</p>
            <p className="text-sm text-muted">{t("feature.link.cardBody")}</p>
          </div>
        </div>
      </section>

      <section className="border-y border-border bg-card">
        <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 lg:py-24">
          <h2 className="text-sm font-medium text-muted">{t("kindsTitle")}</h2>
          <p className="mt-6 max-w-5xl text-3xl font-semibold leading-snug tracking-[-0.02em] sm:text-5xl sm:leading-tight">{t("kinds")}</p>
          <p className="mt-8 max-w-2xl text-lg text-muted">{t("kindsNote")}</p>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-20 sm:px-8 lg:py-24">
        <h2 className="text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">{t("stepsTitle")}</h2>
        <ol className="mt-10 grid gap-8 sm:grid-cols-3">
          {STEPS.map((step, index) => (
            <li key={step} className="border-t-2 border-primary pt-4">
              <p className="text-sm font-semibold text-primary">{index + 1}</p>
              <p className="mt-2 text-xl font-semibold">{t(`step.${step}.title`)}</p>
              <p className="mt-2 text-muted">{t(`step.${step}.body`)}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="mx-auto max-w-3xl px-5 pb-20 sm:px-8 lg:pb-24">
        <h2 className="text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">{t("faqTitle")}</h2>
        <div className="mt-8 divide-y divide-border border-y border-border">
          {QUESTIONS.map((question) => (
            <details key={question} className="group py-1">
              <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 text-lg font-medium">
                {t(`faq.${question}.q`)}
                <span className="text-2xl text-muted transition-transform group-open:rotate-45" aria-hidden="true">
                  +
                </span>
              </summary>
              <p className="pb-5 text-muted">{t(`faq.${question}.a`)}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="bg-[var(--landing-ink)] text-[var(--landing-on-ink)]">
        <div className="mx-auto flex max-w-6xl flex-col items-start gap-6 px-5 py-16 sm:px-8 lg:flex-row lg:items-center lg:justify-between">
          <h2 className="max-w-xl text-3xl font-semibold leading-tight tracking-[-0.02em] sm:text-4xl">{t("closing")}</h2>
          <Link href="/register" className="inline-flex h-12 items-center rounded-control bg-[var(--landing-on-ink)] px-6 text-base font-semibold text-[var(--landing-ink)]">
            {t("create")}
          </Link>
        </div>
      </section>

      <div className="mx-auto max-w-6xl px-5 pb-10 sm:px-8">
        <p className="mt-10 max-w-2xl text-sm text-muted">{t("trust")}</p>
        <PublicFooter />
      </div>
    </div>
  );
}
