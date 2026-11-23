"use client";

import { IDEMPOTENCY_HEADER, LANDED_COST_KINDS, Permission, parseAmount, parseQuantity, spreadByWeight, uuidv7 } from "@bizora/contracts";
import { Button, Card, FormField, PageHeader } from "@bizora/ui";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { BackLink } from "../../../../components/action-link";
import { type FoundProduct, ProductFinder } from "../../../../components/product-finder";
import { RequireAccess } from "../../../../components/require-access";
import { useUnitName } from "../../../../components/stock-quantity";
import { AmountInput, QuantityInput } from "../../../../components/typing";
import { formatCurrency } from "../../../../i18n/format";
import { usePlace } from "../../../../lib/access-context";
import { api } from "../../../../lib/api";
import { problemOf } from "../../../../lib/money-client";

type Line = { key: string; product: FoundProduct; unit: string; quantity: string; cost: string };
type Charge = { key: string; kind: (typeof LANDED_COST_KINDS)[number]; amount: string; paidFrom: "cash" | "bank" };

const selectClass = "h-11 w-full rounded-control border border-border bg-input px-2 text-sm";

/**
 * A delivery with its charges (ADR-048): the goods, and what it cost to bring them (transport, clearing, loading,
 * customs, freight). The charges are shared over the goods by their value and become part of their cost, so profit
 * is right. The supplier is owed for the goods only.
 */
function DeliveryChargesScreen() {
  const t = useTranslations("pricing.delivery");
  const locale = useLocale();
  const place = usePlace();
  const unitName = useUnitName();
  const currency = place.currency;
  const money = (minor: bigint) => formatCurrency(minor, currency, locale);
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);
  const [supplierId, setSupplierId] = useState("");
  const [paidFrom, setPaidFrom] = useState<"credit" | "cash" | "bank">("credit");
  const [lines, setLines] = useState<Line[]>([]);
  const [charges, setCharges] = useState<Charge[]>([{ key: uuidv7(), kind: "transport", amount: "", paidFrom: "cash" }]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    void api("/api/v1/suppliers/names")
      .then(async (response) => (response.ok ? ((await response.json()) as { data: { items: { id: string; name: string }[] } }).data.items : []))
      .then(setSuppliers)
      .catch(() => undefined);
  }, []);

  const goods = lines.map((line) => parseAmount(line.cost, currency) ?? 0n);
  const goodsTotal = goods.reduce((sum, value) => sum + value, 0n);
  const chargeAmounts = charges.map((charge) => (charge.amount.trim() ? parseAmount(charge.amount, currency) : 0n));
  const chargesTotal = chargeAmounts.reduce<bigint>((sum, value) => sum + (value ?? 0n), 0n);
  // The same sharing as the server: each charge by the goods' value, in whole units that add up exactly.
  const shares = lines.map(() => 0n);
  for (const amount of chargeAmounts) {
    spreadByWeight(amount ?? 0n, goods).forEach((share, index) => {
      shares[index] = (shares[index] ?? 0n) + share;
    });
  }

  const update = (key: string, change: Partial<Line>) => setLines((current) => current.map((line) => (line.key === key ? { ...line, ...change } : line)));
  const updateCharge = (key: string, change: Partial<Charge>) => setCharges((current) => current.map((charge) => (charge.key === key ? { ...charge, ...change } : charge)));

  function problem(): string | null {
    if (lines.length === 0) return t("noLines");
    for (const line of lines) {
      const quantity = parseQuantity(line.quantity);
      if (quantity === null || quantity <= 0n) return t("badQuantity", { name: line.product.name });
      const cost = parseAmount(line.cost, currency);
      if (cost === null || cost <= 0n) return t("badCost", { name: line.product.name });
    }
    if (chargeAmounts.some((amount) => amount === null)) return t("badCharge");
    if (paidFrom === "credit" && !supplierId) return t("needSupplier");
    return null;
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    const blocked = problem();
    if (blocked) {
      setError(blocked);
      return;
    }
    const id = uuidv7();
    setPending(true);
    try {
      const response = await api("/api/v1/stock/receipts", {
        method: "POST",
        headers: { [IDEMPOTENCY_HEADER]: id },
        body: JSON.stringify({
          id,
          ...(supplierId ? { supplierId } : {}),
          paidFrom,
          lines: lines.map((line, index) => ({ productId: line.product.id, quantity: line.quantity.trim(), unit: line.unit, totalCostMinor: (goods[index] ?? 0n).toString() })),
          charges: charges
            .map((charge, index) => ({ kind: charge.kind, paidFrom: charge.paidFrom, amountMinor: (chargeAmounts[index] ?? 0n).toString() }))
            .filter((charge) => charge.amountMinor !== "0"),
        }),
      });
      if (!response.ok) {
        setError(await problemOf(response, t("failed")));
        return;
      }
      setNotice(t("saved", { goods: money(goodsTotal), charges: money(chargesTotal) }));
      setLines([]);
      setCharges([{ key: uuidv7(), kind: "transport", amount: "", paidFrom: "cash" }]);
    } catch {
      setError(t("failed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} intro={t("lead")} actions={<BackLink href="/app/stock">{t("back")}</BackLink>} />
      {notice ? (
        <p className="rounded-card border border-success bg-success-bg px-4 py-3 text-sm text-success" role="status">
          {notice}
        </p>
      ) : null}
      <form className="space-y-6" onSubmit={(event) => void save(event)}>
        <Card className="space-y-4">
          <FormField id="delivery-supplier" label={t("supplier")}>
            <select id="delivery-supplier" className={selectClass} value={supplierId} onChange={(event) => setSupplierId(event.target.value)}>
              <option value="">{t("noSupplier")}</option>
              {suppliers.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="delivery-paid" label={t("goodsPaid")}>
            <select id="delivery-paid" className={selectClass} value={paidFrom} onChange={(event) => setPaidFrom(event.target.value as typeof paidFrom)}>
              <option value="credit">{t("owed")}</option>
              <option value="cash">{t("cash")}</option>
              <option value="bank">{t("bank")}</option>
            </select>
          </FormField>
        </Card>
        <section className="space-y-3" aria-labelledby="delivery-goods">
          <h2 id="delivery-goods" className="text-lg font-semibold">
            {t("goods")}
          </h2>
          <ProductFinder id="delivery-product" onPick={(product) => setLines((current) => (current.some((line) => line.product.id === product.id) ? current : [...current, { key: uuidv7(), product, unit: product.baseUnit, quantity: "", cost: "" }]))} />
          <ul className="space-y-3" data-testid="delivery-lines">
            {lines.map((line, index) => (
              <li key={line.key}>
                <Card className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-medium">{line.product.name}</p>
                    <Button type="button" variant="ghost" onClick={() => setLines((current) => current.filter((item) => item.key !== line.key))}>
                      {t("remove")}
                    </Button>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <FormField id={`line-quantity-${line.key}`} label={t("quantity")}>
                      <QuantityInput id={`line-quantity-${line.key}`} value={line.quantity} required onChange={(event) => update(line.key, { quantity: event.target.value })} />
                    </FormField>
                    <FormField id={`line-unit-${line.key}`} label={t("unit")}>
                      <select id={`line-unit-${line.key}`} className={selectClass} value={line.unit} onChange={(event) => update(line.key, { unit: event.target.value })}>
                        {[line.product.baseUnit, ...line.product.packs.map((pack) => pack.unitCode)].map((code) => (
                          <option key={code} value={code}>
                            {unitName(code, 2)}
                          </option>
                        ))}
                      </select>
                    </FormField>
                    <FormField id={`line-cost-${line.key}`} label={t("cost")}>
                      <AmountInput id={`line-cost-${line.key}`} currency={currency} value={line.cost} required onChange={(event) => update(line.key, { cost: event.target.value })} />
                    </FormField>
                  </div>
                  {chargesTotal > 0n && (goods[index] ?? 0n) > 0n ? (
                    <p className="text-sm text-muted" data-testid="line-landed">
                      {t("share", { share: money(shares[index] ?? 0n), total: money((goods[index] ?? 0n) + (shares[index] ?? 0n)) })}
                    </p>
                  ) : null}
                </Card>
              </li>
            ))}
          </ul>
        </section>
        <section className="space-y-3" aria-labelledby="delivery-charges">
          <h2 id="delivery-charges" className="text-lg font-semibold">
            {t("charges")}
          </h2>
          <p className="text-sm text-muted">{t("chargesLead")}</p>
          {charges.map((charge) => (
            <Card key={charge.key} className="grid gap-3 sm:grid-cols-3">
              <FormField id={`charge-kind-${charge.key}`} label={t("chargeKind")}>
                <select id={`charge-kind-${charge.key}`} className={selectClass} value={charge.kind} onChange={(event) => updateCharge(charge.key, { kind: event.target.value as Charge["kind"] })}>
                  {LANDED_COST_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {t(`kinds.${kind}`)}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField id={`charge-amount-${charge.key}`} label={t("amount")}>
                <AmountInput id={`charge-amount-${charge.key}`} currency={currency} value={charge.amount} onChange={(event) => updateCharge(charge.key, { amount: event.target.value })} />
              </FormField>
              <FormField id={`charge-paid-${charge.key}`} label={t("chargePaid")}>
                <select id={`charge-paid-${charge.key}`} className={selectClass} value={charge.paidFrom} onChange={(event) => updateCharge(charge.key, { paidFrom: event.target.value as Charge["paidFrom"] })}>
                  <option value="cash">{t("cash")}</option>
                  <option value="bank">{t("bank")}</option>
                </select>
              </FormField>
            </Card>
          ))}
          {charges.length < 10 ? (
            <Button type="button" variant="outline" onClick={() => setCharges((current) => [...current, { key: uuidv7(), kind: "other", amount: "", paidFrom: "cash" }])}>
              {t("addCharge")}
            </Button>
          ) : null}
        </section>
        <Card data-testid="delivery-total">
          <p className="text-sm text-muted">{t("goodsTotal", { amount: money(goodsTotal) })}</p>
          <p className="text-sm text-muted">{t("chargesTotal", { amount: money(chargesTotal) })}</p>
          <p className="text-lg font-semibold tabular-nums">{t("landedTotal", { amount: money(goodsTotal + chargesTotal) })}</p>
        </Card>
        {error ? (
          <p className="text-sm font-medium text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <Button type="submit" disabled={pending}>
          {pending ? t("saving") : t("save")}
        </Button>
      </form>
    </div>
  );
}

export default function DeliveryChargesPage() {
  return (
    <RequireAccess anyOf={[Permission.PURCHASES_MANAGE]}>
      <DeliveryChargesScreen />
    </RequireAccess>
  );
}
