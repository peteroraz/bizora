import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { formatCurrency, formatWhen } from "../../../i18n/format";

/** A customer's statement, opened from the WhatsApp link without signing in (ADR-019). */
type Statement = {
  businessName: string;
  customerName: string;
  currency: string;
  asOf: string;
  owingMinor: string;
  overdueMinor: string;
  sales: { number: string | null; soldAt: string; dueDate: string | null; overdue: boolean; totalMinor: string; balanceMinor: string }[];
  payments: { number: string; receivedAt: string; method: string; amountMinor: string }[];
};

const origin = process.env.API_ORIGIN ?? "http://localhost:3001";

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function StatementPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) notFound();
  const response = await fetch(`${origin}/api/v1/public/statements/${token}`, { cache: "no-store" }).catch(() => null);
  if (!response?.ok) notFound();
  const statement = ((await response.json()) as { data: { statement: Statement } }).data.statement;
  const t = await getTranslations("statement");
  const locale = await getLocale();
  const money = (minor: string) => formatCurrency(BigInt(minor), statement.currency, locale);

  return (
    <main className="mx-auto max-w-md space-y-4 p-6">
      <header>
        <h1 className="text-xl font-semibold">{statement.businessName}</h1>
        <p className="text-sm text-muted">{t("title", { name: statement.customerName, date: statement.asOf })}</p>
      </header>
      <div className="rounded-card border border-border p-4">
        <p className="text-sm text-muted">{t("owing")}</p>
        <p className="text-2xl font-semibold tabular-nums">{money(statement.owingMinor)}</p>
        {BigInt(statement.overdueMinor) > 0n ? <p className="text-sm text-danger">{t("overdue", { amount: money(statement.overdueMinor) })}</p> : null}
      </div>
      {statement.sales.length > 0 ? (
        <section>
          <h2 className="text-sm font-medium">{t("salesTitle")}</h2>
          <ul className="mt-2 divide-y divide-border border-y border-border">
            {statement.sales.map((sale, index) => (
              <li key={index} className="flex justify-between gap-3 py-2 text-sm">
                <span>
                  <span className="block font-medium">{sale.number}</span>
                  <span className={sale.overdue ? "text-danger" : "text-muted"}>
                    {formatWhen(sale.soldAt, locale, "Africa/Lagos")}
                    {sale.dueDate ? ` · ${t("due", { date: sale.dueDate })}` : ""}
                  </span>
                </span>
                <span className="tabular-nums">{money(sale.balanceMinor)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="text-sm">{t("nothingOwed")}</p>
      )}
      {statement.payments.length > 0 ? (
        <section>
          <h2 className="text-sm font-medium">{t("paymentsTitle")}</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {statement.payments.map((payment) => (
              <li key={payment.number} className="flex justify-between gap-3">
                <span>
                  {payment.number} · {formatWhen(payment.receivedAt, locale, "Africa/Lagos")}
                </span>
                <span className="tabular-nums">{money(payment.amountMinor)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <a href={`/api/v1/public/statements/${token}/pdf`} className="inline-flex items-center rounded-control border border-border px-3 py-2 text-sm font-medium text-primary">
        {t("download")}
      </a>
      <p className="text-xs text-muted">{t("footer")}</p>
    </main>
  );
}
