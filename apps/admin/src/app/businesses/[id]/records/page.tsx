"use client";

import { Badge, Button, Input, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@bizora/ui";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { AdminApiError, adminApi } from "@/lib/admin-api";
import { useCan } from "@/lib/admin-context";
import { day as formatDay, when } from "@/lib/format";
import { amount } from "@/lib/money";

const PAGES = ["sales", "stock", "customers", "debtors", "money", "activity"] as const;
type Page = (typeof PAGES)[number];
type View = { id: string; reason: string; expiresAt: string };
type Answer = { view: View; data: Record<string, unknown> };
type Row = Record<string, unknown>;

const text = (value: unknown) => (value === null || value === undefined ? "" : String(value));
const rows = (data: Record<string, unknown> | undefined, key = "items") => ((data?.[key] as Row[] | undefined) ?? []);

/**
 * The support view (ADR-039): a business's records, read-only, while the staff member's one-hour view is open.
 * Every tab opened is logged for Bizora and shown to the owner.
 */
export default function SupportViewPage() {
  const t = useTranslations("records");
  const errors = useTranslations("errors");
  const { id } = useParams<{ id: string }>();
  const allowed = useCan("records.read");
  const [name, setName] = useState("");
  const [page, setPage] = useState<Page>("sales");
  const [date, setDate] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [closed, setClosed] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void adminApi<{ name: string }>(`/businesses/${id}`)
      .then((profile) => setName(profile.name))
      .catch(() => undefined);
  }, [id]);

  const load = useCallback(
    async (which: Page, onDay: string) => {
      setLoading(true);
      setProblem(null);
      try {
        const query = onDay && (which === "sales" || which === "money") ? `?date=${onDay}` : "";
        setAnswer(await adminApi<Answer>(`/businesses/${id}/records/${which}${query}`));
      } catch (error) {
        if (error instanceof AdminApiError && error.code === "SUPPORT_VIEW_CLOSED") setClosed(true);
        else setProblem(error instanceof AdminApiError && error.message ? error.message : errors("generic"));
      } finally {
        setLoading(false);
      }
    },
    [id, errors],
  );

  useEffect(() => {
    if (allowed) void load(page, date);
  }, [allowed, load, page, date]);

  if (!allowed) return <p role="alert">{errors("notAllowed")}</p>;

  async function closeView() {
    await adminApi(`/businesses/${id}/support-view/close`, { method: "POST" }).catch(() => undefined);
    setClosed(true);
  }

  const back = (
    <Link href={`/businesses/${id}`} className="text-sm text-muted hover:underline">
      {t("backToBusiness")}
    </Link>
  );
  if (closed) {
    return (
      <div className="space-y-4">
        {back}
        <p role="status">{t("closed")}</p>
      </div>
    );
  }

  const data = answer?.data;
  const currency = text((data?.currency as string | undefined) ?? (data?.cash as Row | undefined)?.currency ?? "NGN");
  return (
    <div className="space-y-6">
      {back}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t("title", { name })}</h1>
          {answer ? (
            <p className="text-sm text-muted" data-testid="support-view-status">
              {t("closes", { time: new Date(answer.view.expiresAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) })}{" "}
              {t("reason", { reason: answer.view.reason })}
            </p>
          ) : null}
          <p className="text-xs text-muted">{t("masked")}</p>
        </div>
        <Button variant="secondary" onClick={() => void closeView()}>
          {t("close")}
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-wrap gap-1 rounded-control border border-border p-0.5" role="tablist" aria-label={t("title", { name })}>
          {PAGES.map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={page === option}
              onClick={() => setPage(option)}
              className={`rounded-control px-3 py-1.5 text-sm ${page === option ? "bg-primary text-primary-fg" : "text-muted hover:bg-sidebar"}`}
            >
              {t(`tabs.${option}`)}
            </button>
          ))}
        </div>
        {page === "sales" || page === "money" ? (
          <label className="flex items-center gap-2 text-sm">
            {t("day")}
            <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} className="w-44" />
          </label>
        ) : null}
      </div>

      {problem ? <p role="alert">{problem}</p> : null}
      {loading && !answer ? <Skeleton className="h-48 w-full" /> : null}
      {data ? <Records page={page} data={data} currency={currency} /> : null}
    </div>
  );
}

function Empty() {
  const t = useTranslations("records");
  return <p className="text-sm text-muted">{t("empty")}</p>;
}

function Records({ page, data, currency }: { page: Page; data: Record<string, unknown>; currency: string }) {
  const t = useTranslations("records");
  const c = (key: string) => t(`columns.${key}`);
  if (page === "sales") {
    const items = rows(data);
    if (!items.length) return <Empty />;
    return (
      <Table data-testid="records-sales">
        <TableHeader>
          <TableRow>
            <TableHead>{c("sale")}</TableHead>
            <TableHead>{c("when")}</TableHead>
            <TableHead>{c("by")}</TableHead>
            <TableHead>{c("paid")}</TableHead>
            <TableHead className="text-right">{c("total")}</TableHead>
            <TableHead className="text-right">{c("owing")}</TableHead>
            <TableHead>{c("status")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((sale) => (
            <TableRow key={text(sale.id)}>
              <TableCell>
                <div className="font-medium">{text(sale.number ?? sale.invoiceNumber)}</div>
                <div className="text-muted">{text(sale.customerName) || t("walkIn")}</div>
              </TableCell>
              <TableCell className="whitespace-nowrap">{when(text(sale.soldAt))}</TableCell>
              <TableCell>{text(sale.byName)}</TableCell>
              <TableCell>{((sale.methods as string[] | undefined) ?? []).join(", ")}</TableCell>
              <TableCell className="text-right tabular-nums">{amount(sale.totalMinor as string, currency)}</TableCell>
              <TableCell className="text-right tabular-nums">{amount(sale.balanceMinor as string, currency)}</TableCell>
              <TableCell>
                <Badge>{text(sale.status)}</Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }
  if (page === "stock") {
    const items = rows(data);
    const totals = data.totals as Row | undefined;
    return (
      <div className="space-y-3">
        {totals ? <p className="text-sm">{t("totalStock", { count: Number(totals.products ?? 0), value: amount(totals.sellingValueMinor as string, currency) })}</p> : null}
        {!items.length ? (
          <Empty />
        ) : (
          <Table data-testid="records-stock">
            <TableHeader>
              <TableRow>
                <TableHead>{c("product")}</TableHead>
                <TableHead className="text-right">{c("quantity")}</TableHead>
                <TableHead className="text-right">{c("price")}</TableHead>
                <TableHead className="text-right">{c("cost")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((product) => (
                <TableRow key={text(product.id)}>
                  <TableCell className="font-medium">{text(product.name)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {text(product.quantity)} {text(product.baseUnit)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{amount(product.priceMinor as string | null, currency)}</TableCell>
                  <TableCell className="text-right tabular-nums">{amount((product.costMinor ?? product.averageCostMinor) as string | null, currency)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    );
  }
  if (page === "customers") {
    const items = rows(data);
    if (!items.length) return <Empty />;
    return (
      <Table data-testid="records-customers">
        <TableHeader>
          <TableRow>
            <TableHead>{c("customer")}</TableHead>
            <TableHead>{c("phone")}</TableHead>
            <TableHead>{c("email")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((customer) => (
            <TableRow key={text(customer.id)}>
              <TableCell className="font-medium">{text(customer.name)}</TableCell>
              <TableCell className="admin-mono">{text(customer.phoneE164)}</TableCell>
              <TableCell className="admin-mono">{text(customer.email)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }
  if (page === "debtors") {
    const items = rows(data);
    const totals = data.totals as Row | undefined;
    return (
      <div className="space-y-3">
        {totals ? <p className="text-sm">{t("totalOwed", { count: Number(totals.debtors ?? 0), amount: amount(totals.owingMinor as string, currency) })}</p> : null}
        {!items.length ? (
          <Empty />
        ) : (
          <Table data-testid="records-debtors">
            <TableHeader>
              <TableRow>
                <TableHead>{c("customer")}</TableHead>
                <TableHead className="text-right">{c("owes")}</TableHead>
                <TableHead className="text-right">{c("late")}</TableHead>
                <TableHead>{c("since")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((debtor) => (
                <TableRow key={text(debtor.customerId)}>
                  <TableCell className="font-medium">{text(debtor.name)}</TableCell>
                  <TableCell className="text-right tabular-nums">{amount(debtor.owingMinor as string, currency)}</TableCell>
                  <TableCell className="text-right tabular-nums">{amount(debtor.overdueMinor as string, currency)}</TableCell>
                  <TableCell>{formatDay(text(debtor.oldestDueDate) || null)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    );
  }
  if (page === "money") {
    const cash = data.cash as { currency: string; shops: Row[] } | undefined;
    const profit = data.profit as Row | undefined;
    const money = (value: unknown) => amount(value as string, cash?.currency ?? currency);
    return (
      <div className="space-y-4" data-testid="records-money">
        {profit ? (
          <div className="space-y-1 rounded-card border border-border p-4 text-sm">
            <p className="text-base font-semibold">{t("profit", { amount: money(profit.profitMinor) })}</p>
            <p className="text-muted">
              {t("profitParts", { sales: money(profit.netSalesMinor), cost: money(profit.costOfSalesMinor), expenses: money(profit.expensesMinor), fees: money(profit.posCashoutFeesMinor) })}
            </p>
            {text(profit.notFromSalesMinor) !== "0" && profit.notFromSalesMinor !== undefined ? <p className="text-muted">{t("notFromSales", { amount: money(profit.notFromSalesMinor) })}</p> : null}
          </div>
        ) : null}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{c("shop")}</TableHead>
              <TableHead className="text-right">{c("opening")}</TableHead>
              <TableHead className="text-right">{c("in")}</TableHead>
              <TableHead className="text-right">{c("out")}</TableHead>
              <TableHead className="text-right">{c("expected")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(cash?.shops ?? []).map((shop) => (
              <TableRow key={text(shop.branchId)}>
                <TableCell className="font-medium">{text(shop.name)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(shop.openingMinor)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(shop.inMinor)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(shop.outMinor)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(shop.expectedMinor)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }
  const items = rows(data);
  if (!items.length) return <Empty />;
  return (
    <Table data-testid="records-activity">
      <TableHeader>
        <TableRow>
          <TableHead>{c("when")}</TableHead>
          <TableHead>{c("actor")}</TableHead>
          <TableHead>{c("action")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((entry, index) => (
          <TableRow key={`${text(entry.at)}-${index}`}>
            <TableCell className="whitespace-nowrap">{when(text(entry.at))}</TableCell>
            <TableCell>{entry.actorType === "BIZORA_SUPPORT" ? t("bizoraSupport") : text(entry.actor) || t("system")}</TableCell>
            <TableCell className="admin-mono">{text(entry.action)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
