"use client";

import { Badge, Select, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@bizora/ui";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useCan } from "@/components/admin-shell";
import { adminApi } from "@/lib/admin-api";
import { when } from "@/lib/format";

type Business = {
  id: string;
  name: string;
  sample: boolean;
  lastActive: string | null;
  peopleActive: number;
  sales: number;
  offlineSales: number;
  voidedSales: number;
  creditSales: number;
  debtPayments: number;
  customers: number;
  events: Record<string, number>;
};
type Measures = {
  days: number;
  firstSteps: Record<(typeof STEPS)[number], number>;
  totals: { registeredInPeriod: number; businesses: number; activeBusinesses: number; sales: number; offlineSales: number; syncRejected: number; voiceConfirmed: number; voiceShown: number; voiceDownloadsFailed: number };
  businesses: Business[];
};

const PERIODS = [7, 14, 30, 90];
/** First steps, in the order a new business usually takes them (item 17). */
const STEPS = ["registered", "onboarded", "product", "stock", "sale", "creditSale", "debtPayment", "offlineSale"] as const;

/** Pilot measures (ADR-045): counts per business, no customer names, nothing anyone typed. */
export default function MeasuresPage() {
  const t = useTranslations("measures");
  const errors = useTranslations("errors");
  const allowed = useCan("businesses.read");
  const [days, setDays] = useState(14);
  const [data, setData] = useState<Measures | null>(null);

  useEffect(() => {
    if (!allowed) return;
    setData(null);
    void adminApi<Measures>(`/pilot/measures?days=${days}`).then(setData);
  }, [allowed, days]);

  if (!allowed) return <p role="alert">{errors("notAllowed")}</p>;
  const totals = data?.totals;
  const tiles = totals
    ? [
        { label: t("tiles.registered"), value: String(totals.registeredInPeriod) },
        { label: t("tiles.active"), value: t("tiles.activeValue", { active: totals.activeBusinesses, total: totals.businesses }) },
        { label: t("tiles.sales"), value: String(totals.sales) },
        { label: t("tiles.offline"), value: String(totals.offlineSales) },
        { label: t("tiles.refused"), value: String(totals.syncRejected) },
        { label: t("tiles.voice"), value: t("tiles.voiceValue", { confirmed: totals.voiceConfirmed, shown: totals.voiceShown }) },
        { label: t("tiles.downloads"), value: String(totals.voiceDownloadsFailed) },
      ]
    : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
          <p className="text-muted">{t("lead")}</p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          {t("period")}
          <Select value={String(days)} onChange={(event) => setDays(Number(event.target.value))} data-testid="measures-days">
            {PERIODS.map((period) => (
              <option key={period} value={period}>
                {t("days", { count: period })}
              </option>
            ))}
          </Select>
        </label>
      </div>
      {!data ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          <dl className="grid gap-3 sm:grid-cols-3" data-testid="measures-totals">
            {tiles.map((tile) => (
              <div key={tile.label} className="rounded-card border border-border p-3">
                <dt className="text-sm text-muted">{tile.label}</dt>
                <dd className="text-xl font-semibold tabular-nums">{tile.value}</dd>
              </div>
            ))}
          </dl>
          <section className="space-y-2" aria-labelledby="first-steps">
            <h2 id="first-steps" className="text-lg font-semibold">
              {t("firstSteps.title")}
            </h2>
            <p className="text-sm text-muted">{t("firstSteps.lead")}</p>
            <ol className="grid gap-2 sm:grid-cols-4" data-testid="measures-first-steps">
              {STEPS.map((step) => (
                <li key={step} className="rounded-card border border-border p-3">
                  <p className="text-sm text-muted">{t(`firstSteps.${step}`)}</p>
                  <p className="text-xl font-semibold tabular-nums">{data.firstSteps[step]}</p>
                </li>
              ))}
            </ol>
          </section>
          <p className="text-xs text-muted">{t("sampleNote")}</p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("columns.business")}</TableHead>
                <TableHead>{t("columns.lastActive")}</TableHead>
                <TableHead className="text-right">{t("columns.people")}</TableHead>
                <TableHead className="text-right">{t("columns.sales")}</TableHead>
                <TableHead className="text-right">{t("columns.offline")}</TableHead>
                <TableHead className="text-right">{t("columns.credit")}</TableHead>
                <TableHead className="text-right">{t("columns.voided")}</TableHead>
                <TableHead className="text-right">{t("columns.refused")}</TableHead>
                <TableHead className="text-right">{t("columns.voice")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.businesses.map((row) => (
                <TableRow key={row.id} data-testid={`measures-${row.id}`}>
                  <TableCell>
                    <Link href={`/businesses/${row.id}`} className="font-medium underline-offset-2 hover:underline">
                      {row.name}
                    </Link>{" "}
                    {row.sample ? <Badge tone="info">{t("sample")}</Badge> : null}
                  </TableCell>
                  <TableCell className="text-sm">{row.lastActive ? when(row.lastActive) : t("never")}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.peopleActive}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.sales}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.offlineSales}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.creditSales}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.voidedSales}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.events["sync.rejected"] ?? 0}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {t("voiceCell", { confirmed: row.events["voice.sale_confirmed"] ?? 0, shown: row.events["voice.review_shown"] ?? 0 })}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </div>
  );
}
