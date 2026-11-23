"use client";

import { IDEMPOTENCY_HEADER, Permission, parseAmount, parseQuantity, sellsProducts, sellsTyped, uuidv7 } from "@bizora/contracts";
import { Button, Card, FormField, Input, PageHeader, SafeForm, SubmitButton } from "@bizora/ui";
import { useLocale, useTranslations } from "next-intl";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { PickedCustomer } from "../../../../components/customer-picker";
import { RequireAccess } from "../../../../components/require-access";
import { useStockText, useUnitName } from "../../../../components/stock-quantity";
import { formatCurrency } from "../../../../i18n/format";
import { can } from "../../../../lib/access";
import { useAccess, usePlace } from "../../../../lib/access-context";
import { api } from "../../../../lib/api";
import { type CachedProduct, readCatalog, searchCatalog } from "../../../../lib/offline/catalog";
import { enqueue } from "../../../../lib/offline/outbox";
import { warmOfflineCopy } from "../../../../lib/offline/sw-client";
import { isNetworkFailure } from "../../../../lib/offline/sync";
import { nextProvisionalNumber } from "../../../../lib/provisional";
import { baseQuantity, lineTotal, listPrice } from "../../../../lib/sales-client";
import { refreshOfflineCatalog } from "../../../../lib/stock-client";
import { BackLink } from "../../../../components/action-link";
import { SentenceInput } from "../../../../components/typing";
import { asProduct } from "../../../../lib/offline/typed-product";
import type { QuickSalePicks as QuickSalePicksComponent } from "./quick-sale-picks";

import type { Line } from "../../../../components/quick-sale-lines";
import type { ListPrices } from "../../../../components/sale-price-list";
type PayMode = "cash" | "transfer" | "pos" | "split" | "credit";
const tierPrice = (tiers: { min: bigint; price: bigint }[] | undefined, entered: bigint | null) => (entered === null ? null : (tiers?.find((tier) => entered >= tier.min)?.price ?? null));

/** Quantities are thousandths (ADR-014); the stepper shows them as people type them: "3", "2.5". */
const quantityText = (thousandths: bigint) =>
  thousandths % 1000n === 0n ? (thousandths / 1000n).toString() : `${thousandths / 1000n}.${(thousandths % 1000n).toString().padStart(3, "0").replace(/0+$/, "")}`;

/** Products sold on this phone recently, newest first, for the quick tiles. Kept per shop, on the phone only. */
const RECENT_LIMIT = 24;
const voiceModule = () => import("../../../../components/voice-sale");
const VoiceSale = lazy(voiceModule);
// Loaded when shown, to keep the quick sale within its script budget.
const pickerModule = () => import("../../../../components/customer-picker");
const CustomerPicker = lazy(() => pickerModule().then((module) => ({ default: module.CustomerPicker })));
const creditModule = () => import("../../../../components/credit-fields");
const CreditFields = lazy(creditModule);
const extrasModule = () => import("../../../../components/sale-money-extras");
const SaleMoneyExtras = lazy(extrasModule);
const linesModule = () => import("../../../../components/quick-sale-lines");
const QuickSaleLines = lazy(linesModule);
const savedItemsModule = () => import("../../../../lib/offline/saved-items");
const priceListModule = () => import("../../../../components/sale-price-list");
const SalePriceList = lazy(priceListModule);
const picksModule = () => import("./quick-sale-picks");

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
  const [savedList, setSavedList] = useState<ReturnType<typeof asProduct>[]>([]);
  // Price lists (ADR-048): the one chosen here, and the prices the sale will use.
  const [chosenList, setChosenList] = useState("");
  const [fromList, setFromList] = useState<ListPrices | null>(null);
  const typedOk = sellsTyped(access.salesItems);
  const listOk = sellsProducts(access.salesItems);
  // Say the sale (ADR-033): the voice panel loads only when opened.
  const [voice, setVoice] = useState(false);
  // Bizora operations can switch voice off for a business in the pilot (ADR-045).
  const voiceOn = access.offlineVoice !== false;
  // A sale confirmed on the voice screen is saved once its fields are in place (ADR-040).
  const [autoSave, setAutoSave] = useState(false);
  // Search results load after the screen opens: they are not part of the first script.
  const [Picks, setPicks] = useState<typeof QuickSalePicksComponent | null>(null);
  useEffect(() => {
    const load = () => void picksModule().then((module) => setPicks(() => module.QuickSalePicks));
    if (document.readyState === "complete") window.setTimeout(load, 0);
    else window.addEventListener("load", () => window.setTimeout(load, 0), { once: true });
  }, []);
  const spoken = useRef(false);
  const recentStore = access.owner && access.branchId ? recentKey(access.owner.tenantId, access.branchId) : null;

  useEffect(() => {
    if (recentStore) setRecent(readRecent(recentStore));
  }, [recentStore]);

  // Swapping goods from an earlier sale (ADR-030): start with that customer and say what it replaces.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const customerId = params.get("customer");
    const swap = params.get("swap");
    if (params.get("voice") === "1" && voiceOn) setVoice(true);
    if (customerId) setCustomer({ id: customerId, name: params.get("name") ?? "" });
    if (swap) {
      setNote(t("swapNote", { number: swap }));
      setExtras(true);
    }
  }, [t, voiceOn]);

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
    // Every part loaded later is fetched once the screen has opened, so it is on the phone for selling offline.
    const preload = () => {
      void Promise.all([linesModule(), extrasModule(), creditModule(), pickerModule(), savedItemsModule(), ...(voiceOn ? [voiceModule()] : []), priceListModule()]).catch(() => undefined);
      // Customer names for finding a customer with no network; refreshed at most every few hours.
      if (navigator.onLine) void import("../../../../lib/offline/customers").then((names) => names.refreshCustomerDirectoryIfOld(owner)).catch(() => undefined);
    };
    if (document.readyState === "complete") window.setTimeout(preload, 0);
    else window.addEventListener("load", () => window.setTimeout(preload, 0), { once: true });
    if (typedOk) {
      void (async () => {
        const { readSavedItems, refreshSavedItems } = await savedItemsModule();
        const saved = await readSavedItems(owner);
        if (saved) setSavedList(saved.items.map(asProduct));
        const fresh = await refreshSavedItems(owner);
        if (fresh) setSavedList(fresh.items.map(asProduct));
      })();
    }
  }, [access.owner, access.branchId, typedOk, voiceOn]);

  const place = usePlace();
  const currency = catalog?.currency ?? place.currency;
  const money = (minor: bigint) => formatCurrency(minor, currency, locale);
  const asked = query.trim().toLowerCase();
  // Products from the list and items typed before, as the shop allows (ADR-041).
  const matches = useMemo(
    () => (asked ? [...(listOk && catalog ? searchCatalog(catalog, query) : []), ...savedList.filter((item) => item.name.toLowerCase().includes(asked))].slice(0, 8) : []),
    [catalog, query, asked, listOk, savedList],
  );
  // Quick tiles: what this phone sold recently, then the rest of the list, 12 at most.
  const tiles = useMemo(() => {
    if (!listOk) return savedList.slice(0, 12);
    if (!catalog) return [];
    const all = searchCatalog(catalog, "");
    const byId = new Map(all.map((product) => [product.id, product]));
    const first = recent.map((id) => byId.get(id)).filter((product): product is NonNullable<typeof product> => Boolean(product));
    const seen = new Set(first.map((product) => product.id));
    return [...first, ...all.filter((product) => !seen.has(product.id))].slice(0, 12);
  }, [catalog, recent, listOk, savedList]);

  /** Each line's price and total, worked out the way the server will. Problems are shown before saving. */
  const priced = lines.map((line) => {
    const entered = parseQuantity(line.quantity);
    const list = (line.product.typed ? null : tierPrice(fromList?.tiers.get(`${line.product.id}:${line.unit}`), entered)) ?? listPrice(line.product, line.unit);
    const typed = line.price.trim() ? parseAmount(line.price, currency) : null;
    // A typed item's price is whatever it sells for today; its last price is only a suggestion.
    const unitPrice = (canDiscount || line.product.typed) && typed !== null ? typed : list;
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

  useEffect(() => {
    if (!autoSave) return;
    setAutoSave(false);
    void save();
  }, [autoSave]);

  /** Typed items sold are remembered on this phone at once (the server remembers them with the sale). */
  async function remember() {
    const sold = priced.filter((item) => item.line.product.typed).map((item) => ({ name: item.line.product.name, unit: item.line.unit, priceMinor: String(item.unitPrice) }));
    if (!sold.length || !access.owner) return;
    const saved = await (await savedItemsModule()).rememberOnPhone(access.owner, sold);
    setSavedList(saved.items.map(asProduct));
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
      lines: priced.map((item) =>
        item.line.product.typed
          ? { description: item.line.product.name, quantity: item.line.quantity.trim().replace(/,/g, ""), unit: item.line.unit, unitPriceMinor: String(item.unitPrice), saved: true }
          : {
              productId: item.line.product.id,
              quantity: item.line.quantity.trim().replace(/,/g, ""),
              unit: item.line.unit,
              ...(canDiscount && item.line.price.trim() && item.unitPrice !== null ? { unitPriceMinor: item.unitPrice.toString() } : {}),
            },
      ),
      payments: paidParts.map((part) => ({ method: part.method, amountMinor: (part.amountMinor ?? 0n).toString() })),
      ...(discountMinor > 0n ? { discountMinor: discountMinor.toString() } : {}),
      ...(customer ? { customerId: customer.id } : {}),
      ...(chosenList && fromList ? { priceListId: fromList.id } : {}),
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
        await remember();
        window.location.href = `/app/sales/${payload.data.sale.id}`;
        return;
      }
      setError(payload?.error?.message ?? t("failed"));
    } catch (failure) {
      if (isNetworkFailure(failure) && access.owner) {
        if (recentStore) rememberRecent(recentStore, lines.map((line) => line.product.id));
        await remember();
        const provisional = nextProvisionalNumber();
        await enqueue(
          access.owner,
          "sale.create",
          // Offline, the sale names the list it was priced from, so the server prices it the same way.
          { ...body, ...(fromList ? { priceListId: fromList.id } : {}), provisionalNumber: provisional, soldAt: new Date().toISOString() },
          {
            meta: {
              summary: priced.map((item) => `${item.line.quantity} ${unitName(item.line.unit, Number(item.line.quantity) || 1)} ${item.line.product.name}`).join(", "),
              totalMinor: total.toString(),
              currency,
              customerName: customer?.name ?? null,
              source: spoken.current ? "voice" : "counter",
              number: provisional,
            },
          },
        );
        spoken.current = false;
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
      {voice && voiceOn && catalog ? (
        <Suspense fallback={null}>
          <VoiceSale
            products={[...(listOk ? Object.values(catalog.products) : []), ...savedList]}
            currency={currency}
            owner={access.owner ?? null}
            canChangePrice={canDiscount}
            canGiveCredit={canCredit}
            typedItems={typedOk}
            desk={desk}
            onClose={() => setVoice(false)}
            onDone={(result, saveNow) => {
              // What was said and checked fills the normal sale; saving uses the same path as tapping Save.
              setLines(result.lines.map((line) => ({ key: uuidv7(), ...line })));
              setCustomer(result.customer);
              setMode(result.mode);
              setSplit(result.split);
              setDueDate(result.dueDate);
              setComment(result.comment);
              if (result.balanceMinor > 0n || result.comment) setExtras(true);
              spoken.current = true;
              setVoice(false);
              if (saveNow) setAutoSave(true);
            }}
          />
        </Suspense>
      ) : null}
      {!voice && voiceOn && catalog ? (
        <button type="button" className="flex min-h-14 w-full items-center justify-center gap-2 rounded-card border-2 border-primary text-base font-semibold text-primary" onClick={() => setVoice(true)} data-testid="say-sale">
          {t("voice.open")}
        </button>
      ) : null}
      <FormField id="sale-search" label={t("findProduct")}>
        <div className="flex gap-2">
          <Input id="sale-search" type="search" value={query} placeholder={t("findProductPlaceholder")} autoComplete="off" onChange={(event) => setQuery(event.target.value)} />
        </div>
      </FormField>
      {Picks ? (
        <Picks
          query={query}
          matches={matches}
          tiles={tiles}
          catalogReady={Boolean(catalog)}
          typedOk={typedOk}
          asked={asked}
          onAdd={addProduct}
          money={money}
          stockText={stockText}
        />
      ) : null}
      <SafeForm className="space-y-4" pending={pending} onSubmit={() => void save()}>
        {priced.length > 0 ? (
          <Card className="p-4">
            <Suspense fallback={<p className="text-sm text-muted">{t("loading")}</p>}>
              <QuickSaleLines priced={priced} currency={currency} canDiscount={canDiscount} priceOpen={priceOpen} onPriceOpen={setPriceOpen} onStep={step} onChange={updateLine} />
            </Suspense>
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
          {(mode === "cash" && !desk && total > 0n) || (mode === "split" && !desk) ? (
            <Suspense fallback={null}>
              <SaleMoneyExtras kind={mode === "split" ? "split" : "change"} currency={currency} given={given} onGiven={setGiven} change={change} split={split} onSplit={setSplit} />
            </Suspense>
          ) : null}
        </fieldset>
        <Suspense fallback={null}>
          <SalePriceList customerId={customer?.id ?? null} chosen={chosenList} onChosen={setChosenList} onPrices={setFromList} />
        </Suspense>
        {findsCustomers ? (
          <Card className="p-4">
            <p className="text-sm font-medium">{balance > 0n || mode === "credit" ? t("customer") : t("customerOptional")}</p>
            <div className="mt-2">
              <Suspense fallback={null}>
                <CustomerPicker id="sale-customer" value={customer} onChange={setCustomer} />
              </Suspense>
            </div>
          </Card>
        ) : null}
        {balance > 0n ? (
          <Suspense fallback={null}>
            <CreditFields dueDate={dueDate} comment={comment} onDueDate={setDueDate} onComment={setComment} />
          </Suspense>
        ) : desk ? (
          <FormField id="sale-comment" label={t("deskComment")} hint={t("optional")}>
            <SentenceInput id="sale-comment" value={comment} maxLength={500} onChange={(event) => setComment(event.target.value)} />
          </FormField>
        ) : null}
        {extras || discount.trim() || note.trim() ? (
          <Suspense fallback={null}>
            <SaleMoneyExtras kind="extras" currency={currency} canDiscount={canDiscount} discount={discount} onDiscount={setDiscount} note={note} onNote={setNote} />
          </Suspense>
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
