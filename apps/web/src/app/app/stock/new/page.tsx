"use client";

import { IDEMPOTENCY_HEADER, Permission, UNIT_CODES, amountText, parseAmount, parseQuantity, uuidv7 } from "@bizora/contracts";
import { Button, Card, FormField, Input, PageHeader, SafeForm, Select, SubmitButton } from "@bizora/ui";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { RequireAccess } from "../../../../components/require-access";
import { useUnitName } from "../../../../components/stock-quantity";
import { can } from "../../../../lib/access";
import { useAccess, usePlace } from "../../../../lib/access-context";
import { AmountInput, QuantityInput, SentenceInput } from "../../../../components/typing";
import { formatCurrency } from "../../../../i18n/format";
import { api } from "../../../../lib/api";

type Pack = { unitCode: string; size: string; price: string };

/** A typed amount in the currency's smallest unit, for the API. Empty stays empty; anything invalid throws. */
function minorOf(text: string, currency: string): string | undefined {
  if (!text.trim()) return undefined;
  const value = parseAmount(text, currency);
  if (value === null) throw new Error("amount");
  return value.toString();
}

function quantity(text: string): string | undefined {
  if (!text.trim()) return undefined;
  if (parseQuantity(text) === null) throw new Error("quantity");
  return text.trim().replace(/,/g, "");
}

function NewProductScreen() {
  const t = useTranslations("stock");
  const unitName = useUnitName();
  const access = useAccess();
  const seeCost = can(access, Permission.PRICES_COST_READ);
  const { currency } = usePlace();
  const locale = useLocale();
  const kobo = (text: string) => minorOf(text, currency);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [baseUnit, setBaseUnit] = useState("piece");
  const [price, setPrice] = useState("");
  const [packs, setPacks] = useState<Pack[]>([]);
  const [lowStock, setLowStock] = useState("");
  const [barcode, setBarcode] = useState("");
  const [cost, setCost] = useState("");
  const [trackStock, setTrackStock] = useState(true);
  const [openingQuantity, setOpeningQuantity] = useState("");
  const [openingCost, setOpeningCost] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // What the opening stock cost, worked out from the quantity and the cost per unit until the total is typed.
  const openingThousandths = parseQuantity(openingQuantity);
  const unitCost = parseAmount(cost, currency);
  const workedOutCost = openingThousandths !== null && unitCost !== null ? (openingThousandths * unitCost + 500n) / 1000n : null;

  async function save() {
    setError(null);
    let body: Record<string, unknown>;
    try {
      body = {
        id: uuidv7(),
        name,
        category: category.trim() || null,
        baseUnit,
        priceMinor: kobo(price) ?? null,
        lowStockLevel: quantity(lowStock) ?? null,
        barcode: barcode.trim() || null,
        trackStock,
        packs: packs
          .filter((pack) => pack.size.trim())
          .map((pack) => ({ unitCode: pack.unitCode, baseQuantity: quantity(pack.size), ...(kobo(pack.price) ? { priceMinor: kobo(pack.price) } : {}) })),
        ...(seeCost && kobo(cost) ? { defaultCostMinor: kobo(cost) } : {}),
        ...(trackStock && quantity(openingQuantity) ? { openingQuantity: quantity(openingQuantity) } : {}),
        ...(trackStock && seeCost && (kobo(openingCost) ?? workedOutCost?.toString())
          ? { openingCostMinor: kobo(openingCost) ?? workedOutCost?.toString() }
          : {}),
      };
    } catch (problem) {
      setError((problem as Error).message === "amount" ? t("invalidAmount") : t("invalidQuantity"));
      return;
    }
    setPending(true);
    const response = await api("/api/v1/products", {
      method: "POST",
      headers: { [IDEMPOTENCY_HEADER]: uuidv7() },
      body: JSON.stringify(body),
    }).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    if (response?.ok) {
      window.location.href = `/app/stock/${payload.data.product.id}`;
      return;
    }
    setError(response?.status === 409 ? t("duplicate") : (payload?.error?.message ?? t("failed")));
    setPending(false);
  }

  const unitOptions = UNIT_CODES.map((code) => (
    <option key={code} value={code}>
      {unitName(code, 2)}
    </option>
  ));

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <PageHeader title={t("newTitle")} intro={t("newLead")} />
      <SafeForm className="space-y-4" pending={pending} onSubmit={() => void save()}>
        <FormField id="product-name" label={t("name")}>
          <SentenceInput id="product-name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={160} />
        </FormField>
        <FormField id="product-category" label={t("category")} hint={t("categoryHint")}>
          <SentenceInput id="product-category" value={category} onChange={(event) => setCategory(event.target.value)} maxLength={60} />
        </FormField>
        <FormField id="product-unit" label={t("baseUnit")}>
          <Select id="product-unit" value={baseUnit} onChange={(event) => setBaseUnit(event.target.value)}>
            {unitOptions}
          </Select>
        </FormField>
        <FormField id="product-price" label={t("priceLabel", { unit: unitName(baseUnit, 1) })} hint={t("optional")}>
          <AmountInput currency={currency} id="product-price" value={price} onChange={(event) => setPrice(event.target.value)} />
        </FormField>
        <Card>
          <p className="text-sm font-medium">{t("packsTitle")}</p>
          <p className="text-sm text-muted">{t("packsHint")}</p>
          <div className="mt-3 space-y-3">
            {packs.map((pack, index) => (
              <div key={index} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
                <FormField id={`pack-unit-${index}`} label={t("packUnit")}>
                  <Select
                    id={`pack-unit-${index}`}
                    value={pack.unitCode}
                    onChange={(event) => setPacks(packs.map((item, i) => (i === index ? { ...item, unitCode: event.target.value } : item)))}
                  >
                    {unitOptions}
                  </Select>
                </FormField>
                <FormField id={`pack-size-${index}`} label={t("packSize", { unit: unitName(baseUnit, 2) })}>
                  <QuantityInput
                    id={`pack-size-${index}`}
                    value={pack.size}
                    onChange={(event) => setPacks(packs.map((item, i) => (i === index ? { ...item, size: event.target.value } : item)))}
                  />
                </FormField>
                <FormField id={`pack-price-${index}`} label={t("packPrice")}>
                  <AmountInput
                    currency={currency}
                    id={`pack-price-${index}`}
                    value={pack.price}
                    onChange={(event) => setPacks(packs.map((item, i) => (i === index ? { ...item, price: event.target.value } : item)))}
                  />
                </FormField>
                <Button type="button" variant="ghost" className="self-end" onClick={() => setPacks(packs.filter((_, i) => i !== index))}>
                  {t("removePack")}
                </Button>
              </div>
            ))}
          </div>
          {packs.length < 5 ? (
            <Button type="button" variant="secondary" className="mt-3" onClick={() => setPacks([...packs, { unitCode: "carton", size: "", price: "" }])}>
              {t("addPack")}
            </Button>
          ) : null}
        </Card>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={trackStock} onChange={(event) => setTrackStock(event.target.checked)} />
          {t("trackStock")}
        </label>
        {trackStock ? (
          <FormField id="product-low" label={t("lowStock", { unit: unitName(baseUnit, 2) })} hint={t("optional")}>
            <QuantityInput id="product-low" value={lowStock} onChange={(event) => setLowStock(event.target.value)} />
          </FormField>
        ) : null}
        <FormField id="product-barcode" label={t("barcode")} hint={t("optional")}>
          <Input id="product-barcode" value={barcode} onChange={(event) => setBarcode(event.target.value)} maxLength={64} />
        </FormField>
        {seeCost ? (
          <FormField id="product-cost" label={t("defaultCost", { unit: unitName(baseUnit, 1) })} hint={t("optional")}>
            <AmountInput currency={currency} id="product-cost" value={cost} onChange={(event) => setCost(event.target.value)} />
          </FormField>
        ) : null}
        {trackStock ? (
          <Card>
            <p className="text-sm font-medium">{t("openingTitle")}</p>
            <div className="mt-3 space-y-3">
              <FormField id="product-opening" label={t("openingQuantity", { unit: unitName(baseUnit, 2) })} hint={t("optional")}>
                <QuantityInput id="product-opening" value={openingQuantity} onChange={(event) => setOpeningQuantity(event.target.value)} />
              </FormField>
              {seeCost ? (
                <FormField
                  id="product-opening-cost"
                  label={t("openingCost")}
                  hint={
                    workedOutCost !== null && !openingCost.trim()
                      ? t("openingWorkedOut", {
                          quantity: openingQuantity,
                          cost: formatCurrency(unitCost ?? 0n, currency, locale),
                          total: formatCurrency(workedOutCost, currency, locale),
                        })
                      : t("openingHint")
                  }
                >
                  <AmountInput
                    currency={currency}
                    id="product-opening-cost"
                    value={openingCost}
                    placeholder={workedOutCost !== null ? amountText(workedOutCost, currency) : undefined}
                    onChange={(event) => setOpeningCost(event.target.value)}
                  />
                </FormField>
              ) : null}
            </div>
          </Card>
        ) : null}
        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex items-center gap-4">
          <SubmitButton pending={pending} pendingLabel={t("saving")}>
            {t("save")}
          </SubmitButton>
          <Link href="/app/stock" className="text-sm text-primary">
            {t("back")}
          </Link>
        </div>
      </SafeForm>
    </div>
  );
}

export default function NewProductPage() {
  return (
    <RequireAccess anyOf={[Permission.PRODUCTS_MANAGE]}>
      <NewProductScreen />
    </RequireAccess>
  );
}
