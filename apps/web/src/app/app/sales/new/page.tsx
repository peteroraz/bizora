"use client";

import { IDEMPOTENCY_HEADER, Permission, parseMoneyInput, parseQuantity, uuidv7 } from "@bizora/contracts";
import { Button, Card, FormField, Input, PageHeader, SafeForm, Select, SubmitButton } from "@bizora/ui";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { CustomerPicker, type PickedCustomer } from "../../../../components/customer-picker";
import { RequireAccess } from "../../../../components/require-access";
import { useStockText, useUnitName } from "../../../../components/stock-quantity";
import { formatCurrency } from "../../../../i18n/format";
import { can } from "../../../../lib/access";
import { useAccess } from "../../../../lib/access-context";
import { api } from "../../../../lib/api";
import { type CachedProduct, readCatalog, searchCatalog } from "../../../../lib/offline/catalog";
import { enqueue } from "../../../../lib/offline/outbox";
import { warmOfflineCopy } from "../../../../lib/offline/sw-client";
import { isNetworkFailure } from "../../../../lib/offline/sync";
import { nextProvisionalNumber } from "../../../../lib/provisional";
import { baseQuantity, lineTotal, listPrice, sellingUnits } from "../../../../lib/sales-client";
import { refreshOfflineCatalog } from "../../../../lib/stock-client";

type Line = { key: string; product: CachedProduct; unit: string; quantity: string; price: string };
type PayMode = "cash" | "transfer" | "pos" | "split" | "credit";

/** A kobo amount as typed naira ("4500" or "4500.50"), for showing the list price as a hint. */
const naira = (minor: bigint) => (minor % 100n === 0n ? (minor / 100n).toString() : `${minor / 100n}.${(minor % 100n).toString().padStart(2, "0")}`);

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

  const currency = catalog?.currency ?? "NGN";
  const money = (minor: bigint) => formatCurrency(minor, currency, locale);
  const matches = useMemo(() => (catalog && query.trim() ? searchCatalog(catalog, query).slice(0, 8) : []), [catalog, query]);

  /** Each line's price and total, worked out the way the server will. Problems are shown before saving. */
  const priced = lines.map((line) => {
    const entered = parseQuantity(line.quantity);
    const list = listPrice(line.product, line.unit);
    const typed = line.price.trim() ? parseMoneyInput(line.price) : null;
    const unitPrice = canDiscount && typed !== null ? typed : list;
    const total = entered !== null && unitPrice !== null ? lineTotal(unitPrice, entered) : null;
    const onHand = BigInt(catalog?.quantities[line.product.id] ?? "0");
    const short = line.product.trackStock && entered !== null && baseQuantity(line.product, line.unit, entered) > onHand;
    return { line, entered, list, unitPrice, total, short, onHand };
  });
  const subtotal = priced.reduce((sum, item) => sum + (item.total ?? 0n), 0n);
  const discountMinor = canDiscount && discount.trim() ? (parseMoneyInput(discount) ?? 0n) : 0n;
  const total = subtotal - discountMinor;
  const paidParts = desk
    ? []
    : mode === "split"
      ? (["cash", "transfer", "pos"] as const)
          .map((method) => ({ method, amountMinor: split[method].trim() ? parseMoneyInput(split[method]) : 0n }))
          .filter((part) => part.amountMinor !== 0n)
      : mode === "credit"
        ? []
        : total > 0n
          ? [{ method: mode, amountMinor: total }]
          : [];
  const paid = paidParts.reduce((sum, part) => sum + (part.amountMinor ?? 0n), 0n);
  const balance = desk ? 0n : total - paid;

  function addProduct(product: CachedProduct) {
    setLines((current) => [...current, { key: uuidv7(), product, unit: product.baseUnit, quantity: "1", price: "" }]);
    setQuery("");
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
        window.location.href = `/app/sales/${payload.data.sale.id}`;
        return;
      }
      setError(payload?.error?.message ?? t("failed"));
    } catch (failure) {
      if (isNetworkFailure(failure) && access.owner) {
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
        setMode("cash");
      } else {
        setError(t("failed"));
      }
    } finally {
      setPending(false);
    }
  }

  // At the sales desk any choice is only what the customer said; the cashier decides on credit.
  const modes: PayMode[] = ["cash", "transfer", "pos", "split", ...(canCredit || desk ? (["credit"] as const) : [])];

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader title={t("newTitle")} description={desk ? t("newLeadDesk") : t("newLead")} actions={<Link href="/app/sales" className="text-sm font-medium text-primary">{t("allSales")}</Link>} />
      {savedOffline ? (
        <p className="rounded-card border border-warning bg-warning-bg px-4 py-3 text-sm text-warning" role="status">
          {t("savedOffline", { number: savedOffline })}
        </p>
      ) : null}
      {!catalog ? <p className="text-sm text-muted">{t("noCatalog")}</p> : null}
      <FormField id="sale-search" label={t("findProduct")}>
        <Input id="sale-search" value={query} placeholder={t("findProductPlaceholder")} autoComplete="off" onChange={(event) => setQuery(event.target.value)} />
      </FormField>
      {matches.length > 0 ? (
        <ul className="divide-y divide-border rounded-card border border-border bg-card" aria-label={t("matches")}>
          {matches.map((product) => (
            <li key={product.id}>
              <button type="button" className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left" onClick={() => addProduct(product)}>
                <span className="text-sm font-medium">{product.name}</span>
                <span className="text-sm text-muted">
                  {product.priceMinor ? money(BigInt(product.priceMinor)) : t("noPriceShort")}
                  {product.trackStock ? ` · ${stockText(product.quantity, product.baseUnit, product.packs)}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : query.trim() && catalog ? (
        <p className="text-sm text-muted">{t("noMatches")}</p>
      ) : null}
      <SafeForm className="space-y-4" pending={pending} onSubmit={() => void save()}>
        {priced.length > 0 ? (
          <Card>
            <ul className="space-y-4">
              {priced.map(({ line, list, total: lineAmount, short, onHand }, index) => (
                <li key={line.key} className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium">{line.product.name}</span>
                    <span className="text-sm font-medium tabular-nums">{lineAmount !== null ? money(lineAmount) : "–"}</span>
                  </div>
                  <div className="grid grid-cols-[1fr_1fr_auto] gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
                    <FormField id={`qty-${index}`} label={t("quantity")}>
                      <Input id={`qty-${index}`} inputMode="decimal" value={line.quantity} onChange={(event) => updateLine(line.key, { quantity: event.target.value })} />
                    </FormField>
                    <FormField id={`unit-${index}`} label={t("unit")}>
                      <Select id={`unit-${index}`} value={line.unit} onChange={(event) => updateLine(line.key, { unit: event.target.value, price: "" })}>
                        {sellingUnits(line.product).map((unit) => (
                          <option key={unit} value={unit}>
                            {unitName(unit, 1)}
                          </option>
                        ))}
                      </Select>
                    </FormField>
                    {canDiscount ? (
                      <FormField id={`price-${index}`} label={t("price")}>
                        <Input
                          id={`price-${index}`}
                          inputMode="decimal"
                          value={line.price}
                          placeholder={list !== null ? naira(list) : ""}
                          onChange={(event) => updateLine(line.key, { price: event.target.value })}
                        />
                      </FormField>
                    ) : null}
                    <Button type="button" variant="ghost" className="self-end" onClick={() => setLines(lines.filter((item) => item.key !== line.key))}>
                      {t("remove")}
                    </Button>
                  </div>
                  <p className="text-xs text-muted">
                    {list !== null ? t("eachPrice", { price: money(list), unit: unitName(line.unit, 1) }) : t("noPriceShort")}
                    {short ? ` · ${t("shortStock", { quantity: stockText(onHand.toString(), line.product.baseUnit, line.product.packs) })}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          </Card>
        ) : (
          <p className="text-sm text-muted">{t("startHint")}</p>
        )}
        {canDiscount ? (
          <FormField id="sale-discount" label={t("discount")} hint={t("optional")}>
            <Input id="sale-discount" inputMode="decimal" value={discount} onChange={(event) => setDiscount(event.target.value)} />
          </FormField>
        ) : null}
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{desk ? t("willPayWith") : t("paidWith")}</legend>
          <div className="flex flex-wrap gap-2">
            {modes.map((option) => (
              <Button key={option} type="button" size="sm" variant={mode === option ? "primary" : "secondary"} aria-pressed={mode === option} onClick={() => setMode(option)}>
                {t(`mode.${option}`)}
              </Button>
            ))}
          </div>
          {mode === "split" && !desk ? (
            <div className="grid gap-2 sm:grid-cols-3">
              {(["cash", "transfer", "pos"] as const).map((method) => (
                <FormField key={method} id={`split-${method}`} label={t(`mode.${method}`)}>
                  <Input id={`split-${method}`} inputMode="decimal" value={split[method]} onChange={(event) => setSplit({ ...split, [method]: event.target.value })} />
                </FormField>
              ))}
            </div>
          ) : null}
        </fieldset>
        {findsCustomers ? (
          <Card>
            <p className="text-sm font-medium">{t("customer")}</p>
            <div className="mt-2">
              <CustomerPicker id="sale-customer" value={customer} onChange={setCustomer} />
            </div>
          </Card>
        ) : null}
        {balance > 0n ? (
          <Card>
            <p className="text-sm font-medium">{t("creditTitle")}</p>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <FormField id="sale-due" label={t("dueDate")}>
                <Input id="sale-due" type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
              </FormField>
              <FormField id="sale-credit-comment" label={t("creditComment")}>
                <Input id="sale-credit-comment" value={comment} maxLength={500} onChange={(event) => setComment(event.target.value)} />
              </FormField>
            </div>
          </Card>
        ) : desk ? (
          <FormField id="sale-comment" label={t("deskComment")} hint={t("optional")}>
            <Input id="sale-comment" value={comment} maxLength={500} onChange={(event) => setComment(event.target.value)} />
          </FormField>
        ) : null}
        <FormField id="sale-note" label={t("note")} hint={t("optional")}>
          <Input id="sale-note" value={note} maxLength={240} onChange={(event) => setNote(event.target.value)} />
        </FormField>
        <Card>
          <dl className="grid grid-cols-2 gap-1 text-sm">
            <dt className="text-muted">{t("subtotal")}</dt>
            <dd className="text-right tabular-nums">{money(subtotal)}</dd>
            {discountMinor > 0n ? (
              <>
                <dt className="text-muted">{t("discount")}</dt>
                <dd className="text-right tabular-nums">{money(-discountMinor)}</dd>
              </>
            ) : null}
            <dt className="font-medium">{t("total")}</dt>
            <dd className="text-right font-medium tabular-nums" data-testid="sale-total">
              {money(total)}
            </dd>
            {balance !== 0n ? (
              <>
                <dt className={balance > 0n ? "text-warning" : "text-danger"}>{balance > 0n ? t("owing") : t("tooMuch")}</dt>
                <dd className="text-right tabular-nums">{money(balance > 0n ? balance : -balance)}</dd>
              </>
            ) : null}
          </dl>
        </Card>
        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <SubmitButton pending={pending} pendingLabel={t("saving")}>
          {desk ? t("sendToCashier") : t("record")}
        </SubmitButton>
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
