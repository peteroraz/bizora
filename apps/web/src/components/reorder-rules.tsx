"use client";

import { Permission, parseQuantity, quantityToString } from "@bizora/contracts";
import { Button, Card, FormField, SafeForm, Select, SubmitButton } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { can } from "../lib/access";
import { useAccess } from "../lib/access-context";
import { api } from "../lib/api";
import { QuantityInput, WholeNumberInput } from "./typing";
import { useUnitName } from "./stock-quantity";

type Rule = {
  branchId: string | null;
  branchName: string | null;
  reorderPoint: string | null;
  minQuantity: string | null;
  targetQuantity: string | null;
  maxQuantity: string | null;
  leadTimeDays: number | null;
  preferredSupplierId: string | null;
  supplierName: string | null;
};
type Rules = { baseUnit: string; everyShop: Rule; shops: Rule[]; suppliers: { id: string; name: string; preferred: boolean }[] };

const shown = (value: string | null) => (value === null ? "" : quantityToString(BigInt(value)));
const sent = (value: string) => {
  const trimmed = value.replace(/,/g, "").trim();
  if (!trimmed) return null;
  if (trimmed === "0") return "0";
  return parseQuantity(trimmed) === null ? undefined : trimmed;
};

/**
 * When to buy more of a product, and how much (ADR-063): the reorder point (the low stock level), the minimum, what
 * to fill up to and the most to keep, the usual supplier and how long they take. A shop can have its own rule.
 */
export function ReorderRules({ productId, shops, onChanged }: { productId: string; shops: { id: string; name: string }[]; onChanged: () => void }) {
  const t = useTranslations("reorder");
  const access = useAccess();
  const unitName = useUnitName();
  const [rules, setRules] = useState<Rules | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [shopId, setShopId] = useState<string>("");
  const manage = can(access, Permission.PRODUCTS_MANAGE);
  const everyShopAllowed = !access.membershipBranchId;

  const load = useCallback(async () => {
    const response = await api(`/api/v1/products/${productId}/reorder`).catch(() => null);
    if (response?.ok) setRules((await response.json()).data);
  }, [productId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(form: FormData, branchId: string | null) {
    const field = (name: string) => sent(String(form.get(name) ?? ""));
    const values = { reorderPoint: field("reorderPoint"), minQuantity: field("minQuantity"), targetQuantity: field("targetQuantity"), maxQuantity: field("maxQuantity") };
    if (Object.values(values).some((value) => value === undefined) || values.reorderPoint === null) return setMessage({ tone: "danger", text: t("checkNumbers") });
    const lead = String(form.get("leadTimeDays") ?? "").trim();
    const supplier = String(form.get("supplierId") ?? "");
    setBusy(true);
    setMessage(null);
    const response = await api(`/api/v1/products/${productId}/reorder`, {
      method: "PUT",
      body: JSON.stringify({
        ...(branchId ? { branchId } : {}),
        ...values,
        leadTimeDays: lead ? Number(lead) : null,
        preferredSupplierId: supplier || null,
      }),
    }).catch(() => null);
    setBusy(false);
    const payload = response ? await response.json().catch(() => null) : null;
    if (!response?.ok) return setMessage({ tone: "danger", text: payload?.error?.details?.[0]?.message ?? payload?.error?.message ?? t("failed") });
    setRules(payload.data);
    setMessage({ tone: "success", text: t("saved") });
    if (!branchId) onChanged();
  }

  async function remove(branchId: string) {
    setBusy(true);
    const response = await api(`/api/v1/products/${productId}/reorder?branchId=${branchId}`, { method: "DELETE" }).catch(() => null);
    setBusy(false);
    if (response?.ok) setRules((await response.json()).data);
  }

  if (!rules) return null;
  const unit = unitName(rules.baseUnit, 2);

  const fields = (rule: Rule | null, prefix: string) => (
    <>
      <FormField id={`${prefix}-point`} label={t("reorderPoint", { unit })} hint={t("reorderPointHint")}>
        <QuantityInput id={`${prefix}-point`} name="reorderPoint" required defaultValue={shown(rule?.reorderPoint ?? null)} />
      </FormField>
      <FormField id={`${prefix}-min`} label={t("minimum", { unit })} hint={t("minimumHint")}>
        <QuantityInput id={`${prefix}-min`} name="minQuantity" defaultValue={shown(rule?.minQuantity ?? null)} />
      </FormField>
      <FormField id={`${prefix}-target`} label={t("target", { unit })} hint={t("targetHint")}>
        <QuantityInput id={`${prefix}-target`} name="targetQuantity" defaultValue={shown(rule?.targetQuantity ?? null)} />
      </FormField>
      <FormField id={`${prefix}-max`} label={t("maximum", { unit })} hint={t("optional")}>
        <QuantityInput id={`${prefix}-max`} name="maxQuantity" defaultValue={shown(rule?.maxQuantity ?? null)} />
      </FormField>
      <FormField id={`${prefix}-supplier`} label={t("supplier")} hint={rules.suppliers.length === 0 ? t("noSuppliers") : t("optional")}>
        <Select id={`${prefix}-supplier`} name="supplierId" defaultValue={rule?.preferredSupplierId ?? ""}>
          <option value="">{t("anySupplier")}</option>
          {rules.suppliers.map((supplier) => (
            <option key={supplier.id} value={supplier.id}>
              {supplier.name}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField id={`${prefix}-lead`} label={t("leadTime")} hint={t("optional")}>
        <WholeNumberInput id={`${prefix}-lead`} name="leadTimeDays" defaultValue={rule?.leadTimeDays?.toString() ?? ""} />
      </FormField>
    </>
  );

  const ownShops = shops.filter((shop) => !rules.shops.some((rule) => rule.branchId === shop.id));

  return (
    <Card data-testid="reorder-rules">
      <p className="text-sm font-medium">{t("title")}</p>
      <p className="text-sm text-muted">{t("lead")}</p>
      {message ? (
        <p className={`mt-2 text-sm ${message.tone === "success" ? "text-success" : "text-danger"}`} role="status">
          {message.text}
        </p>
      ) : null}
      {manage && everyShopAllowed ? (
        <SafeForm className="mt-3 grid gap-3 sm:grid-cols-2" pending={busy} onSubmit={(event) => void save(new FormData(event.currentTarget), null)}>
          {fields(rules.everyShop, "reorder-all")}
          <div className="self-end">
            <SubmitButton pending={busy} pendingLabel={t("saving")}>
              {shops.length > 1 ? t("saveEveryShop") : t("save")}
            </SubmitButton>
          </div>
        </SafeForm>
      ) : (
        <p className="mt-2 text-sm">{t("summary", { point: shown(rules.everyShop.reorderPoint) || "–", target: shown(rules.everyShop.targetQuantity) || "–", unit })}</p>
      )}

      {shops.length > 1 ? (
        <div className="mt-4 border-t border-border pt-3">
          <p className="text-sm font-medium">{t("shopRules")}</p>
          {rules.shops.length === 0 ? <p className="text-sm text-muted">{t("noShopRules")}</p> : null}
          <ul className="mt-2 space-y-2 text-sm">
            {rules.shops.map((rule) => (
              <li key={rule.branchId} className="flex flex-wrap items-center justify-between gap-2" data-testid="shop-rule">
                <span>
                  <span className="font-medium">{rule.branchName}</span>
                  {" · "}
                  {t("summary", { point: shown(rule.reorderPoint), target: shown(rule.targetQuantity) || "–", unit })}
                </span>
                {manage ? (
                  <Button variant="secondary" disabled={busy} onClick={() => void remove(rule.branchId as string)}>
                    {t("removeShopRule")}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          {manage && ownShops.length > 0 ? (
            <>
              <FormField id="reorder-shop" label={t("addShopRule")}>
                <Select id="reorder-shop" value={shopId} onChange={(event) => setShopId(event.target.value)}>
                  <option value="">{t("chooseShop")}</option>
                  {ownShops.map((shop) => (
                    <option key={shop.id} value={shop.id}>
                      {shop.name}
                    </option>
                  ))}
                </Select>
              </FormField>
              {shopId ? (
                <SafeForm
                  key={shopId}
                  className="mt-3 grid gap-3 sm:grid-cols-2"
                  pending={busy}
                  onSubmit={async (event) => {
                    await save(new FormData(event.currentTarget), shopId);
                    setShopId("");
                  }}
                >
                  {fields(null, "reorder-shop")}
                  <div className="self-end">
                    <SubmitButton pending={busy} pendingLabel={t("saving")}>
                      {t("saveShop", { shop: shops.find((shop) => shop.id === shopId)?.name ?? "" })}
                    </SubmitButton>
                  </div>
                </SafeForm>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
