"use client";

import { IDEMPOTENCY_HEADER, Permission, amountText, parseAmount, parseQuantity, typeNumber, uuidv7 } from "@bizora/contracts";
import { Button, Card, FormField, Input, PageHeader, SafeForm, SubmitButton } from "@bizora/ui";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { CustomerPicker, type PickedCustomer } from "../../../../components/customer-picker";
import { RequireAccess } from "../../../../components/require-access";
import { useStockText, useUnitName } from "../../../../components/stock-quantity";
import { dayKey, formatCurrency } from "../../../../i18n/format";
import { can } from "../../../../lib/access";
import { useAccess, usePlace } from "../../../../lib/access-context";
import { api } from "../../../../lib/api";
import { type CachedProduct, readCatalog, searchCatalog } from "../../../../lib/offline/catalog";
import { enqueue } from "../../../../lib/offline/outbox";
import { warmOfflineCopy } from "../../../../lib/offline/sw-client";
import { isNetworkFailure } from "../../../../lib/offline/sync";
import { nextProvisionalNumber } from "../../../../lib/provisional";
import { baseQuantity, lineTotal, listPrice, sellingUnits } from "../../../../lib/sales-client";
import { refreshOfflineCatalog } from "../../../../lib/stock-client";
import { BackLink } from "../../../../components/action-link";
import { AmountInput, SentenceInput } from "../../../../components/typing";
import { DueDatePicker } from "../../../../components/due-date-picker";

type Line = { key: string; product: CachedProduct; unit: string; quantity: string; price: string };
type PayMode = "cash" | "transfer" | "pos" | "split" | "credit";

/** Quantities are thousandths (ADR-014); the stepper shows them as people type them: "3", "2.5". */
const quantityText = (thousandths: bigint) =>
  thousandths % 1000n === 0n ? (thousandths / 1000n).toString() : `${thousandths / 1000n}.${(thousandths % 1000n).toString().padStart(3, "0").replace(/0+$/, "")}`;

/** Products sold on this phone recently, newest first, for the quick tiles. Kept per shop, on the phone only. */
const RECENT_LIMIT = 24;
function recentKey(tenantId: string, branchId: string) {
  return `bizora.recentProducts.${tenantId}.${branchId}`;
}
function readRecent(key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
function rememberRecent(key: string, productIds: string[]) {
  try {
    const next = [...new Set([...productIds, ...readRecent(key)])].slice(0, RECENT_LIMIT);
    window.localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // The tiles are a convenience; a phone without storage simply shows the product list.
  }
}


function QuickSaleScreen() {
  const t = useTranslations("sales");
  const locale = useLocale();
  const access = useAccess();
  const unitName = useUnitName();
  const stockText = useStockText();
  const canDiscount = can(access, Permission.SALES_DISCOUNT);
  const canCredit = can(access, Permission.SALES_CREDIT, Permission.DEBTORS_MANAGE);
  // Desk flow (ADR-016): the sales person sends the sale to the cashier, who takes the money.
  const desk = access.salesFlow === "desk";
  const findsCustomers = can(access, Permission.CUSTOMERS_READ, Permission.CUSTOMERS_LOOKUP);
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof readCatalog>>>(null);
  const [query, setQuery] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [discount, setDiscount] = useState("");
  const [mode, setMode] = useState<PayMode>("cash");
  const [split, setSplit] = useState({ cash: "", transfer: "", pos: "" });
  const [customer, setCustomer] = useState<PickedCustomer | null>(null);
  const [note, setNote] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savedOffline, setSavedOffline] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [given, setGiven] = useState("");
  const [extras, setExtras] = useState(false);
  const [priceOpen, setPriceOpen] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const recentStore = access.owner && access.branchId ? recentKey(access.owner.tenantId, access.branchId) : null;

  useEffect(() => {
    if (recentStore) setRecent(readRecent(recentStore));
  }, [recentStore]);

  useEffect(() => {
    const owner = access.owner;
    const branchId = access.branchId;
    if (!owner || !branchId) return;
    void (async () => {
      const saved = await readCatalog(owner.tenantId, branchId).catch(() => null);
      if (saved) setCatalog(saved);
      const fresh = await refreshOfflineCatalog(owner.tenantId, branchId);
      if (fresh) setCatalog(fresh);
    })();
    warmOfflineCopy();
  }, [access.owner, access.branchId]);

  const place = usePlace();
  const currency = catalog?.currency ?? place.currency;
  const money = (minor: bigint) => formatCurrency(minor, currency, locale);
  const matches = useMemo(() => (catalog && query.trim() ? searchCatalog(catalog, query).slice(0, 8) : []), [catalog, query]);
  // Quick tiles: what this phone sold recently, then the rest of the list, 12 at most.
  const tiles = useMemo(() => {
    if (!catalog) return [];
    const all = searchCatalog(catalog, "");
    const byId = new Map(all.map((product) => [product.id, product]));
    const first = recent.map((id) => byId.get(id)).filter((product): product is NonNullable<typeof product> => Boolean(product));
    const seen = new Set(first.map((product) => product.id));
    return [...first, ...all.filter((product) => !seen.has(product.id))].slice(0, 12);
  }, [catalog, recent]);

  /** Each line's price and total, worked out the way the server will. Problems are shown before saving. */
  const priced = lines.map((line) => {
    const entered = parseQuantity(line.quantity);
    const list = listPrice(line.product, line.unit);
    const typed = line.price.trim() ? parseAmount(line.price, currency) : null;
    const unitPrice = canDiscount && typed !== null ? typed : list;
    const total = entered !== null && unitPrice !== null ? lineTotal(unitPrice, entered) : null;
    const onHand = BigInt(catalog?.quantities[line.product.id] ?? "0");
    const short = line.product.trackStock && entered !== null && baseQuantity(line.product, line.unit, entered) > onHand;
    return { line, entered, list, unitPrice, total, short, onHand };
  });
  const subtotal = priced.reduce((sum, item) => sum + (item.total ?? 0n), 0n);
  const discountMinor = canDiscount && discount.trim() ? (parseAmount(discount, currency) ?? 0n) : 0n;
  const total = subtotal - discountMinor;
  const paidParts = desk
    ? []
    : mode === "split"
      ? (["cash", "transfer", "pos"] as const)
          .map((method) => ({ method, amountMinor: split[method].trim() ? parseAmount(split[method], currency) : 0n }))
          .filter((part) => part.amountMinor !== 0n)
      : mode === "credit"
        ? []
        : total > 0n
          ? [{ method: mode, amountMinor: total }]
          : [];
  const paid = paidParts.reduce((sum, part) => sum + (part.amountMinor ?? 0n), 0n);
  const balance = desk ? 0n : total - paid;

  /** Tapping a product again adds one more to its line instead of a second line. */
  function addProduct(product: CachedProduct) {
    setLines((current) => {
      const existing = current.find((line) => line.product.id === product.id);
      if (!existing) return [...current, { key: uuidv7(), product, unit: product.baseUnit, quantity: "1", price: "" }];
      const now = parseQuantity(existing.quantity) ?? 0n;
      return current.map((line) => (line.key === existing.key ? { ...line, quantity: quantityText(now + 1000n) } : line));
    });
    setQuery("");
  }

  function step(line: Line, by: bigint) {
    const now = parseQuantity(line.quantity) ?? 0n;
    const next = now + by;
    if (next <= 0n) setLines((current) => current.filter((item) => item.key !== line.key));
    else updateLine(line.key, { quantity: quantityText(next) });
  }

  function updateLine(key: string, change: Partial<Line>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...change } : line)));
  }

  function problem(): string | null {
    if (lines.length === 0) return t("noLines");
    for (const item of priced) {
      if (item.entered === null || item.entered <= 0n) return t("badQuantity", { name: item.line.product.name });
      if (item.unitPrice === null) return t("noPrice", { name: item.line.product.name });
    }
    if (discountMinor < 0n || discountMinor > subtotal) return t("badDiscount");
    if (paidParts.some((part) => part.amountMinor === null)) return t("badAmount");
    if (balance < 0n) return t("overpaid");
    if (balance > 0n && !canCredit) return t("creditNotAllowed");
    if (balance > 0n && !customer) return t("creditNeedsCustomer");
    if (balance > 0n && customer && customer.credit?.allowed === false) return t("creditCustomerNotApproved", { name: customer.name });
    if (balance > 0n && !dueDate) return t("creditNeedsDate");
    if (balance > 0n && !comment.trim()) return t("creditNeedsComment");
    if (desk && mode === "credit" && !customer) return t("creditNeedsCustomer");
    return null;
  }

  async function save() {
    setError(null);
    setSavedOffline(null);
    const blocked = problem();
    if (blocked) {
      setError(blocked);
      return;
    }
    const id = uuidv7();
    const body = {
      id,
      lines: priced.map((item) => ({
        productId: item.line.product.id,
        quantity: item.line.quantity.trim().replace(/,/g, ""),
        unit: item.line.unit,
        ...(canDiscount && item.line.price.trim() && item.unitPrice !== null ? { unitPriceMinor: item.unitPrice.toString() } : {}),
      })),
      payments: paidParts.map((part) => ({ method: part.method, amountMinor: (part.amountMinor ?? 0n).toString() })),
      ...(discountMinor > 0n ? { discountMinor: discountMinor.toString() } : {}),
      ...(customer ? { customerId: customer.id } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(desk ? { requestedPayment: mode } : {}),
      ...(balance > 0n ? { dueDate } : {}),
      ...(comment.trim() ? { comment: comment.trim() } : {}),
    };
    setPending(true);
    try {
      const response = await api("/api/v1/sales", { method: "POST", headers: { [IDEMPOTENCY_HEADER]: id }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => null);
      if (response.ok) {
        if (recentStore) rememberRecent(recentStore, lines.map((line) => line.product.id));
        window.location.href = `/app/sales/${payload.data.sale.id}`;
        return;
      }
      setError(payload?.error?.message ?? t("failed"));
    } catch (failure) {
      if (isNetworkFailure(failure) && access.owner) {
        if (recentStore) rememberRecent(recentStore, lines.map((line) => line.product.id));
        const provisional = nextProvisionalNumber();
        await enqueue(access.owner, "sale.create", { ...body, provisionalNumber: provisional, soldAt: new Date().toISOString() });
        setSavedOffline(provisional);
        setLines([]);
        setDiscount("");
        setSplit({ cash: "", transfer: "", pos: "" });
        setCustomer(null);
        setNote("");
        setComment("");
        setDueDate("");
        setGiven("");
        setMode("cash");
        if (recentStore) setRecent(readRecent(recentStore));
      } else {
        setError(t("failed"));
      }
    } finally {
      setPending(false);
    }
  }

  // At the sales desk any choice is only what the customer said; the cashier decides on credit.
  const modes: PayMode[] = ["cash", "transfer", "pos", "split", ...(canCredit || desk ? (["credit"] as const) : [])];

  const givenMinor = given.trim() ? parseAmount(given, currency) : null;
  const change = givenMinor !== null ? givenMinor - total : null;
  const itemCount = priced.length;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader title={t("newTitle")} intro={desk ? t("newLeadDesk") : t("newLead")} actions={<BackLink href="/app/sales">{t("allSales")}</BackLink>} />
      {savedOffline ? (
        <p className="rounded-card border border-warning bg-warning-bg px-4 py-3 text-sm text-warning" role="status">
          {t("savedOffline", { number: savedOffline })}
        </p>
      ) : null}
      {!catalog ? <p className="text-sm text-muted">{t("noCatalog")}</p> : null}
      <FormField id="sale-search" label={t("findProduct")}>
        <Input id="sale-search" type="search" value={query} placeholder={t("findProductPlaceholder")} autoComplete="off" onChange={(event) => setQuery(event.target.value)} />
      </FormField>
      {matches.length > 0 ? (
        <ul className="divide-y divide-border rounded-card border border-border bg-card" aria-label={t("matches")}>
          {matches.map((product) => (
            <li key={product.id}>
              <button type="button" className="flex min-h-12 w-full items-center justify-between gap-3 px-4 py-2 text-left" onClick={() => addProduct(product)}>
                <span className="text-sm font-medium">{product.name}</span>
                <span className="text-right text-sm text-muted">
                  {product.priceMinor ? money(BigInt(product.priceMinor)) : t("noPriceShort")}
                  {product.trackStock ? ` · ${stockText(product.quantity, product.baseUnit, product.packs)}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : query.trim() && catalog ? (
        <p className="text-sm text-muted">{t("noMatches")}</p>
      ) : tiles.length > 0 ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label={t("quickPicks")} data-testid="product-tiles">
          {tiles.map((product) => (
            <button
              key={product.id}
              type="button"
              className="flex min-h-16 flex-col items-start justify-between rounded-card border border-border bg-card px-3 py-2 text-left hover:border-primary"
              onClick={() => addProduct(product)}
            >
              <span className="line-clamp-2 text-sm font-medium leading-tight">{product.name}</span>
              <span className="text-xs text-muted">{product.priceMinor ? money(BigInt(product.priceMinor)) : t("noPriceShort")}</span>
            </button>
          ))}
        </div>
      ) : null}
      <SafeForm className="space-y-4" pending={pending} onSubmit={() => void save()}>
        {priced.length > 0 ? (
          <Card className="p-4">
            <ul className="divide-y divide-border">
              {priced.map(({ line, list, total: lineAmount, short, onHand }, index) => (
                <li key={line.key} className="space-y-2 py-3 first:pt-0 last:pb-0">
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-sm font-medium">{line.product.name}</span>
                    <span className="text-sm font-semibold tabular-nums">{lineAmount !== null ? money(lineAmount) : "–"}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex items-center">
                      <button type="button" className="inline-flex h-11 w-11 items-center justify-center rounded-l-control border border-border text-lg" aria-label={t("less", { name: line.product.name })} onClick={() => step(line, -1000n)}>
                        −
                      </button>
                      <label htmlFor={`qty-${index}`} className="sr-only">
                        {t("quantity")}
                      </label>
                      <input
                        id={`qty-${index}`}
                        inputMode="decimal"
                        className="h-11 w-16 border-y border-border bg-input text-center text-base tabular-nums outline-none"
                        value={line.quantity}
                        onChange={(event) => updateLine(line.key, { quantity: typeNumber(event.target.value, 3) })}
                      />
                      <button type="button" className="inline-flex h-11 w-11 items-center justify-center rounded-r-control border border-border text-lg" aria-label={t("more", { name: line.product.name })} onClick={() => step(line, 1000n)}>
                        +
                      </button>
                    </div>
                    {sellingUnits(line.product).length > 1 ? (
                      <div className="flex flex-wrap gap-1" role="group" aria-label={t("unit")}>
                        {sellingUnits(line.product).map((unit) => {
                          const unitPrice = listPrice(line.product, unit);
                          return (
                            <button
                              key={unit}
                              type="button"
                              aria-pressed={line.unit === unit}
                              className={`min-h-11 rounded-control border px-3 text-sm ${line.unit === unit ? "border-primary bg-primary text-primary-fg" : "border-border"}`}
                              onClick={() => updateLine(line.key, { unit, price: "" })}
                            >
                              {unitName(unit, 1)}
                              {unitPrice !== null ? <span className="ml-1 text-xs opacity-80">{money(unitPrice)}</span> : null}
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <span className="text-sm text-muted">{list !== null ? t("eachPrice", { price: money(list), unit: unitName(line.unit, 1) }) : t("noPriceShort")}</span>
                    )}
                  </div>
                  {canDiscount ? (
                    priceOpen === line.key || line.price.trim() ? (
                      <FormField id={`price-${index}`} label={t("price")}>
                        <AmountInput
                          currency={currency}
                          id={`price-${index}`}
                          className="max-w-40"
                          value={line.price}
                          placeholder={list !== null ? amountText(list, currency) : ""}
                          onChange={(event) => updateLine(line.key, { price: event.target.value })}
                        />
                      </FormField>
                    ) : (
                      <button type="button" className="min-h-11 text-sm text-primary" onClick={() => setPriceOpen(line.key)}>
                        {t("changePrice")}
                      </button>
                    )
                  ) : null}
                  {short ? <p className="text-xs text-warning">{t("shortStock", { quantity: stockText(onHand.toString(), line.product.baseUnit, line.product.packs) })}</p> : null}
                </li>
              ))}
            </ul>
          </Card>
        ) : (
          <p className="text-sm text-muted">{t("startHint")}</p>
        )}
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{desk ? t("willPayWith") : t("paidWith")}</legend>
          <div className="flex flex-wrap gap-2">
            {modes.map((option) => (
              <Button key={option} type="button" size="sm" variant={mode === option ? "primary" : "secondary"} aria-pressed={mode === option} onClick={() => setMode(option)}>
                {t(`mode.${option}`)}
              </Button>
            ))}
          </div>
          {mode === "cash" && !desk && total > 0n ? (
            <div className="flex flex-wrap items-end gap-3">
              <FormField id="sale-given" label={t("cashGiven")} hint={t("optional")}>
                <AmountInput currency={currency} id="sale-given" className="max-w-40" value={given} onChange={(event) => setGiven(event.target.value)} />
              </FormField>
              {change !== null ? (
                <p className={`pb-6 text-base font-semibold tabular-nums ${change < 0n ? "text-danger" : "text-success"}`} data-testid="sale-change" role="status">
                  {change < 0n ? t("shortBy", { amount: money(-change) }) : t("change", { amount: money(change) })}
                </p>
              ) : null}
            </div>
          ) : null}
          {mode === "split" && !desk ? (
            <div className="grid gap-2 sm:grid-cols-3">
              {(["cash", "transfer", "pos"] as const).map((method) => (
                <FormField key={method} id={`split-${method}`} label={t(`mode.${method}`)}>
                  <AmountInput currency={currency} id={`split-${method}`} value={split[method]} onChange={(event) => setSplit({ ...split, [method]: event.target.value })} />
                </FormField>
              ))}
            </div>
          ) : null}
        </fieldset>
        {findsCustomers ? (
          <Card className="p-4">
            <p className="text-sm font-medium">{balance > 0n || mode === "credit" ? t("customer") : t("customerOptional")}</p>
            <div className="mt-2">
              <CustomerPicker id="sale-customer" value={customer} onChange={setCustomer} />
            </div>
          </Card>
        ) : null}
        {balance > 0n ? (
          <Card className="p-4">
            <p className="text-sm font-medium">{t("creditTitle")}</p>
            <div className="mt-2 space-y-3">
              <FormField id="sale-due" label={t("dueDate")}>
                <DueDatePicker id="sale-due" value={dueDate} today={dayKey(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone)} onChange={setDueDate} />
              </FormField>
              <FormField id="sale-credit-comment" label={t("creditComment")}>
                <SentenceInput id="sale-credit-comment" value={comment} maxLength={500} onChange={(event) => setComment(event.target.value)} />
              </FormField>
            </div>
          </Card>
        ) : desk ? (
          <FormField id="sale-comment" label={t("deskComment")} hint={t("optional")}>
            <SentenceInput id="sale-comment" value={comment} maxLength={500} onChange={(event) => setComment(event.target.value)} />
          </FormField>
        ) : null}
        {extras || discount.trim() || note.trim() ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {canDiscount ? (
              <FormField id="sale-discount" label={t("discount")} hint={t("optional")}>
                <AmountInput currency={currency} id="sale-discount" value={discount} onChange={(event) => setDiscount(event.target.value)} />
              </FormField>
            ) : null}
            <FormField id="sale-note" label={t("note")} hint={t("optional")}>
              <SentenceInput id="sale-note" value={note} maxLength={240} onChange={(event) => setNote(event.target.value)} />
            </FormField>
          </div>
        ) : (
          <button type="button" className="min-h-11 text-sm font-medium text-primary" onClick={() => setExtras(true)}>
            {canDiscount ? t("addDiscountOrNote") : t("addNote")}
          </button>
        )}
        {/* Always in reach: the total and the button stay at the bottom of the screen, above the menu bar. */}
        <div className="sticky bottom-[4.25rem] z-10 -mx-4 border-t border-border bg-card px-4 py-3 shadow-[0_-4px_12px_rgba(0,0,0,0.06)] md:bottom-0 md:mx-0 md:rounded-card md:border">
          {error ? (
            <p className="mb-2 text-sm text-danger" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs text-muted">
                {t("itemCount", { count: itemCount })}
                {discountMinor > 0n ? ` · ${t("discountShort", { amount: money(discountMinor) })}` : ""}
                {balance > 0n ? ` · ${t("owingShort", { amount: money(balance) })}` : balance < 0n ? ` · ${t("tooMuchShort", { amount: money(-balance) })}` : ""}
              </p>
              <p className="text-xl font-semibold tabular-nums" data-testid="sale-total">
                {money(total)}
              </p>
            </div>
            <SubmitButton pending={pending} pendingLabel={t("saving")} className="h-12 px-6 text-base">
              {desk ? t("sendToCashier") : t("record")}
            </SubmitButton>
          </div>
        </div>
      </SafeForm>
    </div>
  );
}

export default function QuickSalePage() {
  return (
    <RequireAccess anyOf={[Permission.SALES_CREATE]}>
      <QuickSaleScreen />
    </RequireAccess>
  );
}
