"use client";

import { IDEMPOTENCY_HEADER, Permission, UNIT_CODES, amountText, parseAmount, parseQuantity, uuidv7 } from "@bizora/contracts";
import { Button, Card, FormField, Input, PageHeader, SafeForm, Select, SubmitButton } from "@bizora/ui";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { RequireAccess } from "../../../../components/require-access";
import { useUnitName } from "../../../../components/stock-quantity";
import { can } from "../../../../lib/access";
import { useAccess, usePlace } from "../../../../lib/access-context";
import { AmountInput, QuantityInput, SentenceInput } from "../../../../components/typing";
import { formatCurrency } from "../../../../i18n/format";
import { api } from "../../../../lib/api";
import { photoToUpload } from "../../../../lib/capture-client";

type Option = { id: string; name: string; path?: string; active?: boolean };
type Kind = "physical" | "service" | "non_stock";

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
  const batchText = useTranslations("batches");
  const [tracksBatches, setTracksBatches] = useState(false);
  const serialText = useTranslations("serials");
  const [tracksSerials, setTracksSerials] = useState(false);
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
  const [kind, setKind] = useState<Kind>("physical");
  const trackStock = kind === "physical";
  const [more, setMore] = useState(false);
  const [sku, setSku] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [brandId, setBrandId] = useState("");
  const [brandName, setBrandName] = useState("");
  const [categories, setCategories] = useState<Option[]>([]);
  const [brands, setBrands] = useState<Option[]>([]);
  // Until the lists have loaded (or failed), the fields wait, so a typed category does not jump into another field.
  const [listsReady, setListsReady] = useState(false);
  const [photo, setPhoto] = useState<File | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);

  // Categories and brands load only when More options is opened: the simple form needs neither.
  useEffect(() => {
    if (!more || listsReady) return;
    void Promise.all([
      api("/api/v1/catalog/categories")
        .then(async (response) => (response.ok ? setCategories(((await response.json()).data.categories as Option[]).filter((row) => row.active !== false)) : undefined))
        .catch(() => undefined),
      api("/api/v1/catalog/brands")
        .then(async (response) => (response.ok ? setBrands(((await response.json()).data.brands as Option[]).filter((row) => row.active !== false)) : undefined))
        .catch(() => undefined),
    ]).finally(() => setListsReady(true));
  }, [more, listsReady]);
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
        // A chosen category by ID; a typed new one by name (the server makes it).
        ...(categoryId ? { categoryId } : { category: category.trim() || null }),
        ...(brandId ? { brandId } : {}),
        itemType: kind,
        sku: sku.trim() || null,
        baseUnit,
        priceMinor: kobo(price) ?? null,
        lowStockLevel: quantity(lowStock) ?? null,
        barcode: barcode.trim() || null,
        trackStock,
        ...(trackStock && tracksBatches ? { tracksBatches: true } : {}),
        ...(trackStock && tracksSerials ? { tracksSerials: true } : {}),
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
    // A brand typed but not on the list is added first.
    if (!brandId && brandName.trim()) {
      const made = await api("/api/v1/catalog/brands", { method: "POST", headers: { [IDEMPOTENCY_HEADER]: uuidv7() }, body: JSON.stringify({ name: brandName.trim() }) }).catch(() => null);
      const madePayload = made ? await made.json().catch(() => null) : null;
      if (made?.ok) body.brandId = madePayload.data.brand.id;
      else if (made?.status === 409 && madePayload?.error?.fieldErrors?.[0]?.message) body.brandId = madePayload.error.fieldErrors[0].message;
    }
    const response = await api("/api/v1/products", {
      method: "POST",
      headers: { [IDEMPOTENCY_HEADER]: uuidv7() },
      body: JSON.stringify(body),
    }).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    if (response?.ok) {
      const id = payload.data.product.id as string;
      // The photo is optional and sent after the item is saved; the item is kept even if the photo fails.
      if (photo) {
        const upload = await photoToUpload(photo).catch(() => null);
        if (upload) await api(`/api/v1/products/${id}/photos`, { method: "POST", body: JSON.stringify(upload) }).catch(() => null);
      }
      window.location.href = `/app/stock/${id}`;
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
        <FormField id="product-unit" label={t("baseUnit")}>
          <Select id="product-unit" value={baseUnit} onChange={(event) => setBaseUnit(event.target.value)}>
            {unitOptions}
          </Select>
        </FormField>
        <FormField id="product-price" label={t("priceLabel", { unit: unitName(baseUnit, 1) })} hint={t("optional")}>
          <AmountInput currency={currency} id="product-price" value={price} onChange={(event) => setPrice(event.target.value)} />
        </FormField>
        {trackStock ? (
          <FormField id="product-opening" label={t("openingQuantity", { unit: unitName(baseUnit, 2) })} hint={t("optional")}>
            <QuantityInput id="product-opening" value={openingQuantity} onChange={(event) => setOpeningQuantity(event.target.value)} />
          </FormField>
        ) : null}
        <FormField id="product-photo" label={t("photo")} hint={t("optional")}>
          <input
            ref={photoInput}
            id="product-photo"
            type="file"
            accept="image/jpeg,image/png"
            capture="environment"
            className="block w-full text-sm"
            onChange={(event) => setPhoto(event.target.files?.[0] ?? null)}
          />
        </FormField>
        <Button type="button" variant="ghost" aria-expanded={more} aria-controls="product-more" onClick={() => setMore(!more)} data-testid="product-more">
          {more ? t("fewerOptions") : t("moreOptions")}
        </Button>
        {more ? (
          <div id="product-more" className="space-y-4 border-l-2 border-border pl-4">
            <FormField id="product-kind" label={t("kind")}>
              <Select id="product-kind" value={kind} onChange={(event) => setKind(event.target.value as Kind)}>
                <option value="physical">{t("kinds.physical")}</option>
                <option value="service">{t("kinds.service")}</option>
                <option value="non_stock">{t("kinds.non_stock")}</option>
              </Select>
            </FormField>
            <FormField id="product-category" label={t("category")} hint={t("categoryHint")}>
              {!listsReady ? (
                <Select id="product-category" disabled>
                  <option>{t("loadingLists")}</option>
                </Select>
              ) : categories.length > 0 ? (
                <Select id="product-category" value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
                  <option value="">{t("noCategory")}</option>
                  {categories.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.path ?? row.name}
                    </option>
                  ))}
                </Select>
              ) : (
                <SentenceInput id="product-category" value={category} onChange={(event) => setCategory(event.target.value)} maxLength={60} />
              )}
            </FormField>
            {categories.length > 0 && !categoryId ? (
              <FormField id="product-category-new" label={t("newCategory")} hint={t("optional")}>
                <SentenceInput id="product-category-new" value={category} onChange={(event) => setCategory(event.target.value)} maxLength={60} />
              </FormField>
            ) : null}
            <FormField id="product-brand" label={t("brand")} hint={t("optional")}>
              {!listsReady ? (
                <Select id="product-brand" disabled>
                  <option>{t("loadingLists")}</option>
                </Select>
              ) : brands.length > 0 ? (
                <Select id="product-brand" value={brandId} onChange={(event) => setBrandId(event.target.value)}>
                  <option value="">{t("noBrand")}</option>
                  {brands.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name}
                    </option>
                  ))}
                </Select>
              ) : (
                <SentenceInput id="product-brand" value={brandName} onChange={(event) => setBrandName(event.target.value)} maxLength={80} />
              )}
            </FormField>
            {brands.length > 0 && !brandId ? (
              <FormField id="product-brand-new" label={t("newBrand")} hint={t("optional")}>
                <SentenceInput id="product-brand-new" value={brandName} onChange={(event) => setBrandName(event.target.value)} maxLength={80} />
              </FormField>
            ) : null}
            {seeCost ? (
              <FormField id="product-cost" label={t("defaultCost", { unit: unitName(baseUnit, 1) })} hint={t("optional")}>
                <AmountInput currency={currency} id="product-cost" value={cost} onChange={(event) => setCost(event.target.value)} />
              </FormField>
            ) : null}
            {trackStock && seeCost ? (
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
            {trackStock ? (
              <FormField id="product-low" label={t("lowStock", { unit: unitName(baseUnit, 2) })} hint={t("optional")}>
                <QuantityInput id="product-low" value={lowStock} onChange={(event) => setLowStock(event.target.value)} />
              </FormField>
            ) : null}
            {trackStock ? (
              <>
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-1" checked={tracksBatches} onChange={(event) => setTracksBatches(event.target.checked)} />
                  <span>
                    <span className="block font-medium">{batchText("keep")}</span>
                    <span className="block text-muted">{batchText("keepHint")}</span>
                  </span>
                </label>
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-1" checked={tracksSerials} onChange={(event) => setTracksSerials(event.target.checked)} />
                  <span>
                    <span className="block font-medium">{serialText("keep")}</span>
                    <span className="block text-muted">{serialText("keepHint")}</span>
                  </span>
                </label>
              </>
            ) : null}
            <FormField id="product-barcode" label={t("barcode")} hint={t("optional")}>
              <Input id="product-barcode" value={barcode} onChange={(event) => setBarcode(event.target.value)} maxLength={64} inputMode="numeric" />
            </FormField>
            <FormField id="product-sku" label={t("sku")} hint={t("skuHint")}>
              <Input id="product-sku" value={sku} onChange={(event) => setSku(event.target.value)} maxLength={64} autoCapitalize="characters" />
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
          </div>
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
