"use client";

import {
  IDEMPOTENCY_HEADER,
  Permission,
  STOCK_ADD_REASONS,
  STOCK_REMOVE_REASONS,
  parseCountQuantity,
  amountText,
  parseAmount,
  parseQuantity,
  quantityToString,
  uuidv7,
} from "@bizora/contracts";
import { Badge, Button, Card, FormField, Input, PageHeader, SafeForm, Select, SubmitButton } from "@bizora/ui";
import { useParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { RequireAccess } from "../../../../components/require-access";
import { ProductBuying } from "../../../../components/product-buying";
import { useStockText, useUnitName } from "../../../../components/stock-quantity";
import { formatCurrency, formatWhen } from "../../../../i18n/format";
import { can } from "../../../../lib/access";
import { useAccess, usePlace } from "../../../../lib/access-context";
import { api } from "../../../../lib/api";
import { enqueue } from "../../../../lib/offline/outbox";
import { isNetworkFailure } from "../../../../lib/offline/sync";
import type { ProductView } from "../../../../lib/stock-client";
import { BackLink } from "../../../../components/action-link";
import { ProductPhotos } from "../../../../components/product-photos";
import { AmountInput, NameInput, QuantityInput, SentenceInput } from "../../../../components/typing";

type Detail = ProductView & {
  /** The item this product belongs to, and its other variants (ADR-046). */
  item?: { id: string; name: string; itemType: string; categoryPath: string | null; brandName: string | null; variants: { id: string; name: string; variantLabel: string | null }[] } | null;
  sku?: string | null;
  currency: string;
  shops: { branchId: string; branchName: string; quantity: string; belowZero: boolean; valueMinor?: string; inTransitIn?: string; inTransitOut?: string }[];
};
type ProductChange = {
  id: string;
  action: "product.updated" | "product.archived" | "stock.count_rejected";
  at: string;
  byName: string | null;
  reason: string | null;
  changes: Record<string, [string | null, string | null]>;
  countedQuantity?: string | null;
};

type Movement = {
  id: string;
  type: string;
  quantity: string;
  enteredQuantity: string;
  enteredUnit: string;
  reason: string | null;
  note: string | null;
  supplier: string | null;
  documentNumber: string | null;
  createdAt: string;
  branchName: string;
  byName: string | null;
  deviceName: string | null;
  valueMinor?: string;
};
type Message = { tone: "success" | "warning" | "danger"; text: string } | null;

/** A saved amount back into a box, exactly and in the currency's decimals: "150050" → "1,500.50". */
function amountInput(minor: string | null | undefined, currency: string) {
  return minor ? amountText(BigInt(minor), currency) : "";
}

/** Stock in: the cost of one unit and the total work each other out from the quantity, whichever is typed. */
type ReceiveDraft = { quantity: string; each: string; total: string; typed: "each" | "total" | null };
const emptyReceive: ReceiveDraft = { quantity: "", each: "", total: "", typed: null };

function workOutReceive(draft: ReceiveDraft, currency: string): ReceiveDraft {
  const quantity = parseQuantity(draft.quantity);
  if (quantity === null) return draft;
  if (draft.typed === "each") {
    const each = parseAmount(draft.each, currency);
    return { ...draft, total: each === null ? "" : amountText((quantity * each + 500n) / 1000n, currency) };
  }
  if (draft.typed === "total") {
    const total = parseAmount(draft.total, currency);
    return { ...draft, each: total === null ? "" : amountText((total * 1000n + quantity / 2n) / quantity, currency) };
  }
  return draft;
}

function ProductScreen() {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations("stock");
  const common = useTranslations("common");
  const locale = useLocale();
  const { timezone: timeZone } = usePlace();
  const access = useAccess();
  const stockText = useStockText();
  const unitName = useUnitName();
  const seeCost = can(access, Permission.PRICES_COST_READ);
  const [product, setProduct] = useState<Detail | null>(null);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [changes, setChanges] = useState<ProductChange[]>([]);
  const [archiveReason, setArchiveReason] = useState("");
  const [shops, setShops] = useState<{ id: string; name: string }[]>([]);
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [receive, setReceive] = useState<ReceiveDraft>(emptyReceive);
  // Stock in on credit names the supplier owed and when to pay (ADR-029); names come from the supplier list.
  const [receivePaid, setReceivePaid] = useState<"credit" | "cash" | "bank">("credit");
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);
  const supplierNames = suppliers.map((supplier) => supplier.name);
  // Goods sent back to a supplier (ADR-030): off what is owed, or money back.
  const [sendBackSettle, setSendBackSettle] = useState<"owed" | "cash" | "bank">("owed");
  useEffect(() => {
    if (!can(access, Permission.STOCK_RECEIVE, Permission.PURCHASES_MANAGE)) return;
    void api("/api/v1/suppliers/names")
      .then(async (response) => (response.ok ? setSuppliers((await response.json()).data.items as { id: string; name: string }[]) : undefined))
      .catch(() => undefined);
  }, [access]);

  const load = useCallback(async () => {
    try {
      const [productResponse, movementResponse, changesResponse] = await Promise.all([
        api(`/api/v1/products/${id}`),
        api(`/api/v1/products/${id}/movements`),
        api(`/api/v1/products/${id}/changes`).catch(() => null),
      ]);
      if (changesResponse?.ok) setChanges((await changesResponse.json()).data.items);
      if (productResponse.ok) setProduct((await productResponse.json()).data.product);
      if (movementResponse.ok) setMovements((await movementResponse.json()).data.items);
    } catch {
      setMessage({ tone: "warning", text: t("offlineNever") });
    }
  }, [id, t]);

  useEffect(() => {
    void load();
    if (can(access, Permission.STOCK_TRANSFER)) {
      void api("/api/v1/stock/shops")
        .then(async (response) => (response.ok ? setShops((await response.json()).data.items) : undefined))
        .catch(() => undefined);
    }
  }, [load, access]);

  /** Sends a stock change. With no network, stock in and counts wait on the phone and sync later. */
  async function submit(kind: string, path: string, body: Record<string, unknown>, success: string, offlineType?: "stock.receive" | "stock.count" | "stock.adjust") {
    setBusy(kind);
    setMessage(null);
    try {
      if (typeof navigator !== "undefined" && navigator.onLine === false) throw new TypeError("offline");
      const response = await api(path, { method: "POST", headers: { [IDEMPOTENCY_HEADER]: uuidv7() }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setMessage({ tone: "danger", text: payload?.error?.message ?? t("failed") });
        return false;
      }
      const status = payload?.data?.count?.status;
      // A store keeper's change waits for a manager or owner (ADR-034).
      setMessage({ tone: "success", text: payload?.data?.waiting ? t("sentForApproval") : status === "pending" ? t("countPending") : success });
      await load();
      return true;
    } catch (error) {
      if (offlineType && access.owner && isNetworkFailure(error)) {
        await enqueue(access.owner, offlineType, body);
        setMessage({ tone: "warning", text: t("savedOffline") });
        return true;
      }
      setMessage({ tone: "danger", text: t("failed") });
      return false;
    } finally {
      setBusy(null);
    }
  }

  if (!product) return <p className="text-sm text-muted">{message?.text ?? common("loading")}</p>;

  const units = [product.baseUnit, ...product.packs.map((pack) => pack.unitCode)];
  const unitSelect = (formId: string) => (
    <FormField id={`${formId}-unit`} label={t("unit")}>
      <Select id={`${formId}-unit`} name="unit" defaultValue={product.baseUnit}>
        {units.map((unit) => (
          <option key={unit} value={unit}>
            {unitName(unit, 2)}
          </option>
        ))}
      </Select>
    </FormField>
  );
  const money = (minor: string | null | undefined) => (minor ? formatCurrency(BigInt(minor), product.currency, locale) : "");
  // One history, newest first: stock movements and changes to the product with their reasons (7f).
  const timeline = [
    ...movements.map((movement) => ({ kind: "movement" as const, at: String(movement.createdAt), movement })),
    ...changes.map((change) => ({ kind: "change" as const, at: change.at, change })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const changeValue = (name: string, value: string | null) => {
    if (value === null || value === "") return t("changeNone");
    if (name === "price" || name === "cost") return money(value);
    if (name === "lowStockLevel") return stockText(value, product.baseUnit, product.packs);
    if (name === "trackStock") return value === "true" ? t("changeYes") : t("changeNo");
    return value;
  };
  const movementRow = (movement: Movement) => (
            <li key={movement.id} className="py-2">
              <div className="flex flex-wrap justify-between gap-2">
                <span className="font-medium">
                  {t(`types.${movement.type}`)}
                  {movement.reason && t.has(`reasons.${movement.reason}`) ? ` · ${t(`reasons.${movement.reason}`)}` : ""}
                  {movement.documentNumber ? ` · ${movement.documentNumber}` : ""}
                </span>
                <span className={BigInt(movement.quantity) < 0n ? "text-danger" : "text-success"}>
                  {BigInt(movement.quantity) > 0n ? "+" : ""}
                  {stockText(movement.quantity, product.baseUnit, product.packs)}
                </span>
              </div>
              <p className="text-muted">
                {t("byLine", { who: movement.byName ?? "", shop: movement.branchName, when: formatWhen(movement.createdAt, locale, timeZone) })}
                {movement.deviceName ? ` ${t("onDevice", { device: movement.deviceName })}` : ""}
                {movement.supplier ? ` · ${movement.supplier}` : ""}
                {seeCost && movement.valueMinor ? ` · ${money(movement.valueMinor.replace("-", ""))}` : ""}
              </p>
              {movement.note ? <p className="text-muted">{movement.note}</p> : null}
            </li>
  );
  const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
  const otherShops = shops.filter((shop) => shop.id !== access.branchId);

  return (
    <div className="space-y-6">
      <PageHeader
        title={product.name}
        description={[product.item?.categoryPath ?? product.category, product.item?.brandName, product.sku ? t("skuShown", { sku: product.sku }) : null, product.priceMinor ? t("price", { price: money(product.priceMinor), unit: unitName(product.baseUnit, 1) }) : null]
          .filter(Boolean)
          .join(" · ")}
        actions={
          <BackLink href="/app/stock">{t("back")}</BackLink>
        }
      />
      {product.item && product.item.variants.length > 1 ? (
        <nav aria-label={t("variants")} className="flex flex-wrap gap-2" data-testid="product-variants">
          {product.item.variants.map((variant) => (
            <a
              key={variant.id}
              href={`/app/stock/${variant.id}`}
              aria-current={variant.id === product.id ? "page" : undefined}
              className={`inline-flex min-h-11 items-center rounded-control border px-3 text-sm ${variant.id === product.id ? "border-primary font-medium" : "border-border"}`}
            >
              {variant.variantLabel ?? variant.name}
            </a>
          ))}
        </nav>
      ) : null}
      {message ? (
        <p
          className={`rounded-card border px-4 py-3 text-sm ${
            message.tone === "success" ? "border-success bg-success-bg text-success" : message.tone === "warning" ? "border-warning bg-warning-bg text-warning" : "border-danger bg-danger-bg text-danger"
          }`}
          role="status"
        >
          {message.text}
        </p>
      ) : null}

      <ProductPhotos productId={product.id} productName={product.name} canManage={can(access, Permission.PRODUCTS_MANAGE) && !product.archived} />

      <Card>
        <p className="text-sm font-medium">{t("shops")}</p>
        <ul className="mt-3 space-y-2 text-sm">
          {(product.shops.length > 0 ? product.shops : [{ branchId: "here", branchName: "", quantity: "0", belowZero: false }]).map((shop) => (
            <li key={shop.branchId} className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {shop.branchName}
                {shop.inTransitIn && shop.inTransitIn !== "0" ? <span className="block text-xs text-muted">{t("onTheWayIn", { quantity: stockText(shop.inTransitIn, product.baseUnit, product.packs) })}</span> : null}
                {shop.inTransitOut && shop.inTransitOut !== "0" ? <span className="block text-xs text-muted">{t("onTheWayOut", { quantity: stockText(shop.inTransitOut, product.baseUnit, product.packs) })}</span> : null}
              </span>
              <span className="flex items-center gap-2 font-medium">
                {stockText(shop.quantity, product.baseUnit, product.packs)}
                {shop.belowZero ? <Badge tone="danger">{t("belowZero")}</Badge> : null}
                {seeCost && shop.valueMinor ? <span className="text-muted">{t("value", { value: money(shop.valueMinor) })}</span> : null}
              </span>
            </li>
          ))}
        </ul>
        {product.stock.low ? <Badge tone="warning" className="mt-3">{t("low")}</Badge> : null}
      </Card>

      {product.trackStock && can(access, Permission.STOCK_RECEIVE) ? (
        <Card>
          <p className="text-sm font-medium">{t("receiveTitle")}</p>
          <SafeForm
            className="mt-3 grid gap-3 sm:grid-cols-2"
            pending={busy === "receive"}
            onSubmit={async (event) => {
              const form = new FormData(event.currentTarget);
              const quantity = receive.quantity.replace(/,/g, "");
              const cost = receive.total;
              if (!parseQuantity(quantity)) return setMessage({ tone: "danger", text: t("invalidQuantity") });
              if (cost && parseAmount(cost, product.currency) === null) return setMessage({ tone: "danger", text: t("invalidAmount") });
              if (receivePaid === "credit" && field(form, "supplier").length < 2) return setMessage({ tone: "danger", text: t("supplierRequired") });
              const ok = await submit(
                "receive",
                "/api/v1/stock/receive",
                {
                  id: uuidv7(),
                  productId: product.id,
                  quantity,
                  unit: field(form, "unit"),
                  paidFrom: field(form, "paidFrom") || "credit",
                  ...(cost ? { totalCostMinor: (parseAmount(cost, product.currency) as bigint).toString() } : {}),
                  ...(field(form, "supplier") ? { supplier: field(form, "supplier") } : {}),
                  ...(receivePaid === "credit" && field(form, "payBy") ? { payBy: field(form, "payBy") } : {}),
                  ...(field(form, "note") ? { note: field(form, "note") } : {}),
                },
                t("received"),
                "stock.receive",
              );
              if (ok) {
                (event.target as HTMLFormElement).reset();
                setReceive(emptyReceive);
                setReceivePaid("credit");
              }
            }}
          >
            <FormField id="receive-quantity" label={t("quantity")}>
              <QuantityInput
                id="receive-quantity"
                name="quantity"
                required
                value={receive.quantity}
                onChange={(event) => setReceive(workOutReceive({ ...receive, quantity: event.target.value }, product.currency))}
              />
            </FormField>
            {unitSelect("receive")}
            {seeCost ? (
              <FormField id="receive-each" label={t("costEach")} hint={t("costEachHint")}>
                <AmountInput
                  currency={product.currency}
                  id="receive-each"
                  value={receive.each}
                  onChange={(event) => setReceive(workOutReceive({ ...receive, each: event.target.value, typed: "each" }, product.currency))}
                />
              </FormField>
            ) : null}
            <FormField id="receive-cost" label={t("totalCost")} hint={t("totalCostHint")}>
              <AmountInput
                currency={product.currency}
                id="receive-cost"
                name="totalCost"
                value={receive.total}
                onChange={(event) => setReceive(workOutReceive({ ...receive, total: event.target.value, typed: "total" }, product.currency))}
              />
            </FormField>
            <FormField id="receive-paid" label={t("paidFrom")}>
              <Select
                id="receive-paid"
                name="paidFrom"
                value={receivePaid}
                onChange={(event) => setReceivePaid(event.target.value as "credit" | "cash" | "bank")}
              >
                <option value="credit">{t("paid.credit")}</option>
                {can(access, Permission.PURCHASES_MANAGE) ? (
                  <>
                    <option value="cash">{t("paid.cash")}</option>
                    <option value="bank">{t("paid.bank")}</option>
                  </>
                ) : null}
              </Select>
            </FormField>
            <FormField id="receive-supplier" label={t("supplier")} hint={receivePaid === "credit" ? undefined : t("optional")}>
              <NameInput id="receive-supplier" name="supplier" maxLength={160} list="supplier-names" required={receivePaid === "credit"} />
            </FormField>
            <datalist id="supplier-names">
              {supplierNames.map((supplierName) => (
                <option key={supplierName} value={supplierName} />
              ))}
            </datalist>
            {receivePaid === "credit" ? (
              <FormField id="receive-pay-by" label={t("payBy")} hint={t("payByHint")}>
                <Input id="receive-pay-by" name="payBy" type="date" />
              </FormField>
            ) : null}
            <FormField id="receive-note" label={t("note")} hint={t("receiveNoteHint")}>
              <SentenceInput id="receive-note" name="note" maxLength={240} />
            </FormField>
            <div className="self-end">
              <SubmitButton pending={busy === "receive"} pendingLabel={t("saving")}>
                {t("receive")}
              </SubmitButton>
            </div>
          </SafeForm>
        </Card>
      ) : null}

      {product.trackStock && can(access, Permission.STOCK_RECEIVE) && suppliers.length > 0 ? (
        <Card>
          <p className="text-sm font-medium">{t("sendBackTitle")}</p>
          <p className="text-sm text-muted">{t("sendBackLead")}</p>
          <SafeForm
            className="mt-3 grid gap-3 sm:grid-cols-2"
            pending={busy === "sendBack"}
            onSubmit={async (event) => {
              const form = new FormData(event.currentTarget);
              const quantity = field(form, "quantity").replace(/,/g, "");
              if (!parseQuantity(quantity)) return setMessage({ tone: "danger", text: t("invalidQuantity") });
              const ok = await submit(
                "sendBack",
                "/api/v1/stock/return-to-supplier",
                {
                  id: uuidv7(),
                  productId: product.id,
                  supplierId: field(form, "supplierId"),
                  quantity,
                  unit: field(form, "unit"),
                  settle: sendBackSettle,
                  ...(field(form, "note") ? { note: field(form, "note") } : {}),
                },
                t("sentBack"),
              );
              if (ok) {
                (event.target as HTMLFormElement).reset();
                setSendBackSettle("owed");
              }
            }}
          >
            <FormField id="sendback-supplier" label={t("supplier")}>
              <Select id="sendback-supplier" name="supplierId" required defaultValue="">
                <option value="" disabled>
                  {t("pickSupplier")}
                </option>
                {suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField id="sendback-quantity" label={t("quantity")}>
              <QuantityInput id="sendback-quantity" name="quantity" required />
            </FormField>
            {unitSelect("sendback")}
            <FormField id="sendback-settle" label={t("sendBackSettle")}>
              <Select id="sendback-settle" value={sendBackSettle} onChange={(event) => setSendBackSettle(event.target.value as "owed" | "cash" | "bank")}>
                <option value="owed">{t("settle.owed")}</option>
                {can(access, Permission.PURCHASES_MANAGE) ? (
                  <>
                    <option value="cash">{t("settle.cash")}</option>
                    <option value="bank">{t("settle.bank")}</option>
                  </>
                ) : null}
              </Select>
            </FormField>
            <FormField id="sendback-note" label={t("note")} hint={t("optional")}>
              <SentenceInput id="sendback-note" name="note" maxLength={240} />
            </FormField>
            <div className="self-end">
              <SubmitButton pending={busy === "sendBack"} pendingLabel={t("saving")}>
                {t("sendBack")}
              </SubmitButton>
            </div>
          </SafeForm>
        </Card>
      ) : null}

      {product.trackStock && can(access, Permission.STOCK_ADJUST, Permission.STOCK_COUNT) ? (
        <Card>
          <p className="text-sm font-medium">{t("adjustTitle")}</p>
          <SafeForm
            className="mt-3 grid gap-3 sm:grid-cols-2"
            pending={busy === "adjust"}
            onSubmit={async (event) => {
              const form = new FormData(event.currentTarget);
              const reason = field(form, "reason");
              const quantity = field(form, "quantity");
              if (!parseQuantity(quantity)) return setMessage({ tone: "danger", text: t("invalidQuantity") });
              const direction = (STOCK_ADD_REASONS as readonly string[]).includes(reason) ? "add" : "remove";
              const ok = await submit(
                "adjust",
                "/api/v1/stock/adjust",
                { productId: product.id, direction, reason, quantity, unit: field(form, "unit"), note: field(form, "note") },
                t("adjusted"),
                "stock.adjust",
              );
              if (ok) (event.target as HTMLFormElement).reset();
            }}
          >
            <FormField id="adjust-reason" label={t("reason")}>
              <Select id="adjust-reason" name="reason" defaultValue="damaged">
                <optgroup label={t("remove")}>
                  {STOCK_REMOVE_REASONS.map((reason) => (
                    <option key={reason} value={reason}>
                      {t(`reasons.${reason}`)}
                    </option>
                  ))}
                </optgroup>
                <optgroup label={t("addBack")}>
                  {STOCK_ADD_REASONS.map((reason) => (
                    <option key={reason} value={reason}>
                      {t(`reasons.${reason}`)}
                    </option>
                  ))}
                </optgroup>
              </Select>
            </FormField>
            <FormField id="adjust-quantity" label={t("quantity")}>
              <QuantityInput id="adjust-quantity" name="quantity" required />
            </FormField>
            {unitSelect("adjust")}
            <FormField id="adjust-note" label={t("whatHappened")} hint={t("whatHappenedHint")}>
              <SentenceInput id="adjust-note" name="note" required minLength={3} maxLength={240} />
            </FormField>
            <div>
              <SubmitButton pending={busy === "adjust"} pendingLabel={t("saving")}>
                {t("adjust")}
              </SubmitButton>
            </div>
          </SafeForm>
        </Card>
      ) : null}

      {product.trackStock && can(access, Permission.STOCK_TRANSFER) && otherShops.length > 0 ? (
        <Card>
          <p className="text-sm font-medium">{t("transferTitle")}</p>
          <SafeForm
            className="mt-3 grid gap-3 sm:grid-cols-2"
            pending={busy === "transfer"}
            onSubmit={async (event) => {
              const form = new FormData(event.currentTarget);
              const quantity = field(form, "quantity");
              if (!parseQuantity(quantity)) return setMessage({ tone: "danger", text: t("invalidQuantity") });
              const ok = await submit(
                "transfer",
                "/api/v1/stock/transfer",
                { productId: product.id, toBranchId: field(form, "toBranchId"), quantity, unit: field(form, "unit"), ...(field(form, "note") ? { note: field(form, "note") } : {}) },
                t("transferred"),
              );
              if (ok) (event.target as HTMLFormElement).reset();
            }}
          >
            <FormField id="transfer-shop" label={t("toShop")}>
              <Select id="transfer-shop" name="toBranchId">
                {otherShops.map((shop) => (
                  <option key={shop.id} value={shop.id}>
                    {shop.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField id="transfer-quantity" label={t("quantity")}>
              <QuantityInput id="transfer-quantity" name="quantity" required />
            </FormField>
            {unitSelect("transfer")}
            <FormField id="transfer-note" label={t("note")} hint={t("optional")}>
              <SentenceInput id="transfer-note" name="note" maxLength={240} />
            </FormField>
            <div className="self-end">
              <SubmitButton pending={busy === "transfer"} pendingLabel={t("saving")}>
                {t("transfer")}
              </SubmitButton>
            </div>
          </SafeForm>
        </Card>
      ) : null}

      {product.trackStock && can(access, Permission.STOCK_COUNT) ? (
        <Card>
          <p className="text-sm font-medium">{t("countTitle")}</p>
          <SafeForm
            className="mt-3 grid gap-3 sm:grid-cols-2"
            pending={busy === "count"}
            onSubmit={async (event) => {
              const form = new FormData(event.currentTarget);
              const counted = field(form, "counted");
              if (parseCountQuantity(counted) === null) return setMessage({ tone: "danger", text: t("invalidQuantity") });
              const ok = await submit(
                "count",
                "/api/v1/stock/counts",
                { id: uuidv7(), productId: product.id, countedQuantity: counted, unit: field(form, "unit"), ...(field(form, "note") ? { note: field(form, "note") } : {}) },
                t("countSaved"),
                "stock.count",
              );
              if (ok) (event.target as HTMLFormElement).reset();
            }}
          >
            <FormField id="count-quantity" label={t("counted")}>
              <QuantityInput id="count-quantity" name="counted" required />
            </FormField>
            {unitSelect("count")}
            <FormField id="count-note" label={t("note")} hint={t("countNoteHint")}>
              <SentenceInput id="count-note" name="note" maxLength={240} />
            </FormField>
            <div>
              <SubmitButton pending={busy === "count"} pendingLabel={t("saving")}>
                {t("count")}
              </SubmitButton>
            </div>
          </SafeForm>
        </Card>
      ) : null}

      <Card>
        <p className="text-sm font-medium">{t("history")}</p>
        {movements.length === 0 && changes.length === 0 ? <p className="mt-2 text-sm text-muted">{t("noHistory")}</p> : null}

        <ul className="mt-3 divide-y divide-border text-sm" data-testid="product-history">
          {timeline.map((entry) =>
            entry.kind === "change" ? (
              <li key={entry.change.id} className="py-2" data-testid="product-change">
                <p className="font-medium">{t(`changeKinds.${entry.change.action.replace(".", "_")}`)}</p>
                {Object.entries(entry.change.changes).map(([name, [before, after]]) => (
                  <p key={name} className="text-muted">
                    {t("changedFrom", {
                      field: t.has(`changeFields.${name}`) ? t(`changeFields.${name}`) : name,
                      before: changeValue(name, before),
                      after: changeValue(name, after),
                    })}
                  </p>
                ))}
                {entry.change.action === "stock.count_rejected" && entry.change.countedQuantity ? (
                  <p className="text-muted">{t("rejectedCount", { counted: stockText(entry.change.countedQuantity, product.baseUnit, product.packs) })}</p>
                ) : null}
                {entry.change.reason ? <p>{t("reasonLine", { reason: entry.change.reason })}</p> : null}
                <p className="text-muted">{t("changedBy", { who: entry.change.byName ?? "", when: formatWhen(entry.change.at, locale, timeZone) })}</p>
              </li>
            ) : (
              movementRow(entry.movement)
            ),
          )}
        </ul>
      </Card>

      {can(access, Permission.PRODUCTS_MANAGE) && !product.archived ? (
        <Card>
          <p className="text-sm font-medium">{t("edit")}</p>
          <SafeForm
            className="mt-3 grid gap-3 sm:grid-cols-2"
            pending={busy === "edit"}
            onSubmit={async (event) => {
              const form = new FormData(event.currentTarget);
              const price = field(form, "price");
              const low = field(form, "low");
              const cost = field(form, "cost");
              if ((price && parseAmount(price, product.currency) === null) || (cost && parseAmount(cost, product.currency) === null)) {
                return setMessage({ tone: "danger", text: t("invalidAmount") });
              }
              if (low && low !== "0" && parseQuantity(low) === null) return setMessage({ tone: "danger", text: t("invalidQuantity") });
              const packs = product.packs.map((pack) => {
                const packPrice = field(form, `pack-${pack.unitCode}`);
                return {
                  unitCode: pack.unitCode,
                  baseQuantity: quantityToString(BigInt(pack.baseQuantity)),
                  ...(packPrice && parseAmount(packPrice, product.currency) !== null ? { priceMinor: (parseAmount(packPrice, product.currency) as bigint).toString() } : {}),
                };
              });
              setBusy("edit");
              const response = await api(`/api/v1/products/${product.id}`, {
                method: "PATCH",
                body: JSON.stringify({
                  name: field(form, "name"),
                  category: field(form, "category") || null,
                  baseUnit: product.baseUnit,
                  priceMinor: price ? (parseAmount(price, product.currency) as bigint).toString() : null,
                  lowStockLevel: low || null,
                  barcode: product.barcode,
                  trackStock: product.trackStock,
                  packs,
                  ...(seeCost ? { defaultCostMinor: cost ? (parseAmount(cost, product.currency) as bigint).toString() : null } : {}),
                  ...(field(form, "changeReason") ? { changeReason: field(form, "changeReason") } : {}),
                }),
              }).catch(() => null);
              setBusy(null);
              const payload = response ? await response.json().catch(() => null) : null;
              if (response?.ok) {
                setProduct(payload.data.product);
                setMessage({ tone: "success", text: t("updated") });
                const reasonBox = (event.target as HTMLFormElement).querySelector<HTMLInputElement>("#edit-reason");
                if (reasonBox) reasonBox.value = "";
                const refreshed = await api(`/api/v1/products/${product.id}/changes`).catch(() => null);
                if (refreshed?.ok) setChanges((await refreshed.json()).data.items);
              } else {
                setMessage({ tone: "danger", text: response?.status === 409 ? t("duplicate") : (payload?.error?.message ?? t("failed")) });
              }
            }}
          >
            <FormField id="edit-name" label={t("name")}>
              <SentenceInput id="edit-name" name="name" defaultValue={product.name} required maxLength={160} />
            </FormField>
            <FormField id="edit-category" label={t("category")} hint={t("optional")}>
              <SentenceInput id="edit-category" name="category" defaultValue={product.category ?? ""} maxLength={60} />
            </FormField>
            <FormField id="edit-price" label={t("priceLabel", { unit: unitName(product.baseUnit, 1) })} hint={t("optional")}>
              <AmountInput currency={product.currency} id="edit-price" name="price" defaultValue={amountInput(product.priceMinor, product.currency)} />
            </FormField>
            {product.packs.map((pack) => (
              <FormField key={pack.unitCode} id={`edit-pack-${pack.unitCode}`} label={`${t("packPrice")} · ${unitName(pack.unitCode, 1)}`} hint={t("optional")}>
                <AmountInput
                  currency={product.currency}
                  id={`edit-pack-${pack.unitCode}`}
                  name={`pack-${pack.unitCode}`}
                  defaultValue={amountInput(pack.priceMinor, product.currency)}
                />
              </FormField>
            ))}
            {product.trackStock ? (
              <FormField id="edit-low" label={t("lowStock", { unit: unitName(product.baseUnit, 2) })} hint={t("optional")}>
                <QuantityInput id="edit-low" name="low" defaultValue={product.lowStockLevel ? quantityToString(BigInt(product.lowStockLevel)) : ""} />
              </FormField>
            ) : null}
            {seeCost ? (
              <FormField id="edit-cost" label={t("defaultCost", { unit: unitName(product.baseUnit, 1) })} hint={t("optional")}>
                <AmountInput currency={product.currency} id="edit-cost" name="cost" defaultValue={amountInput(product.defaultCostMinor, product.currency)} />
              </FormField>
            ) : null}
            <FormField id="edit-reason" label={t("changeReason")} hint={t("changeReasonHint")}>
              <SentenceInput id="edit-reason" name="changeReason" maxLength={240} />
            </FormField>
            <div className="self-end">
              <SubmitButton pending={busy === "edit"} pendingLabel={t("saving")}>
                {t("save")}
              </SubmitButton>
            </div>
          </SafeForm>
        </Card>
      ) : null}

      <ProductBuying productId={product.id} currency={product.currency} />

      {can(access, Permission.PRODUCTS_MANAGE) && !product.archived ? (
        <div className="space-y-3">
          {confirmArchive ? (
            <FormField id="archive-reason" label={t("archiveReason")} hint={t("optional")}>
              <SentenceInput id="archive-reason" value={archiveReason} maxLength={240} onChange={(event) => setArchiveReason(event.target.value)} />
            </FormField>
          ) : null}
          <Button
            variant={confirmArchive ? "danger" : "secondary"}
            onClick={async () => {
              if (!confirmArchive) return setConfirmArchive(true);
              const response = await api(`/api/v1/products/${product.id}/archive`, {
                method: "POST",
                body: JSON.stringify(archiveReason.trim() ? { reason: archiveReason.trim() } : {}),
              }).catch(() => null);
              if (response?.ok) window.location.href = "/app/stock";
            }}
          >
            {confirmArchive ? t("archiveConfirm") : t("archive")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export default function ProductPage() {
  return (
    <RequireAccess anyOf={[Permission.STOCK_READ]}>
      <ProductScreen />
    </RequireAccess>
  );
}
