"use client";

import { IDEMPOTENCY_HEADER, Permission, uuidv7 } from "@bizora/contracts";
import { Button, Card, FormField, PageHeader, SafeForm, Select, SubmitButton } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { BackLink } from "../../../../components/action-link";
import { RequireAccess } from "../../../../components/require-access";
import { SentenceInput } from "../../../../components/typing";
import { can } from "../../../../lib/access";
import { useAccess } from "../../../../lib/access-context";
import { api } from "../../../../lib/api";

type Category = { id: string; name: string; parentId: string | null; depth: number; path: string; active: boolean; itemCount: number };
type Brand = { id: string; name: string; active: boolean };

/** Categories (nested) and brands for the business's items (ADR-046). Optional: an item needs neither. */
function CategoriesScreen() {
  const t = useTranslations("catalog");
  const access = useAccess();
  const manage = can(access, Permission.PRODUCTS_MANAGE);
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [brands, setBrands] = useState<Brand[] | null>(null);
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const [brand, setBrand] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    const [c, b] = await Promise.all([api("/api/v1/catalog/categories"), api("/api/v1/catalog/brands")]).catch(() => [null, null]);
    if (c?.ok) setCategories((await c.json()).data.categories);
    else setCategories([]);
    if (b?.ok) setBrands((await b.json()).data.brands);
    else setBrands([]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function send(path: string, method: string, body: unknown) {
    setPending(true);
    setProblem(null);
    const response = await api(path, { method, headers: method === "POST" ? { [IDEMPOTENCY_HEADER]: uuidv7() } : {}, body: JSON.stringify(body) }).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    setPending(false);
    if (!response?.ok) {
      setProblem(response ? (payload?.error?.message ?? t("failed")) : t("needsNetwork"));
      return false;
    }
    await load();
    return true;
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <BackLink href="/app/stock">{t("back")}</BackLink>
      <PageHeader title={t("title")} intro={t("lead")} />
      {problem ? (
        <p className="text-sm text-danger" role="alert">
          {problem}
        </p>
      ) : null}

      <Card className="space-y-3">
        <h2 className="text-lg font-semibold">{t("categories")}</h2>
        {categories === null ? null : categories.length === 0 ? (
          <p className="text-sm text-muted">{t("noCategories")}</p>
        ) : (
          <ul className="divide-y divide-border" data-testid="category-list">
            {categories.map((row) => (
              <li key={row.id} className="flex min-h-11 items-center justify-between gap-3 py-2" style={{ paddingLeft: `${row.depth * 1.25}rem` }}>
                <span className={row.active ? "" : "text-muted line-through"}>
                  {row.name} <span className="text-xs text-muted">{t("itemCount", { count: row.itemCount })}</span>
                </span>
                {manage ? (
                  <Button type="button" variant="ghost" disabled={pending} onClick={() => void send(`/api/v1/catalog/categories/${row.id}`, "PATCH", { active: !row.active })}>
                    {row.active ? t("stopUsing") : t("useAgain")}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {manage ? (
          <SafeForm
            className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]"
            pending={pending}
            onSubmit={() =>
              void send("/api/v1/catalog/categories", "POST", { name, ...(parentId ? { parentId } : {}) }).then((done) => {
                if (done) setName("");
              })
            }
          >
            <FormField id="category-name" label={t("newCategory")}>
              <SentenceInput id="category-name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={60} />
            </FormField>
            <FormField id="category-parent" label={t("inside")}>
              <Select id="category-parent" value={parentId} onChange={(event) => setParentId(event.target.value)}>
                <option value="">{t("topLevel")}</option>
                {(categories ?? [])
                  .filter((row) => row.active)
                  .map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.path}
                    </option>
                  ))}
              </Select>
            </FormField>
            <SubmitButton className="self-end" pending={pending} pendingLabel={t("saving")}>
              {t("addCategory")}
            </SubmitButton>
          </SafeForm>
        ) : null}
      </Card>

      <Card className="space-y-3">
        <h2 className="text-lg font-semibold">{t("brands")}</h2>
        {brands === null ? null : brands.length === 0 ? (
          <p className="text-sm text-muted">{t("noBrands")}</p>
        ) : (
          <ul className="flex flex-wrap gap-2" data-testid="brand-list">
            {brands.map((row) => (
              <li key={row.id} className="rounded-control border border-border px-3 py-1 text-sm">
                {row.name}
              </li>
            ))}
          </ul>
        )}
        {manage ? (
          <SafeForm
            className="grid gap-3 sm:grid-cols-[1fr_auto]"
            pending={pending}
            onSubmit={() =>
              void send("/api/v1/catalog/brands", "POST", { name: brand }).then((done) => {
                if (done) setBrand("");
              })
            }
          >
            <FormField id="brand-name" label={t("newBrand")}>
              <SentenceInput id="brand-name" value={brand} onChange={(event) => setBrand(event.target.value)} required maxLength={80} />
            </FormField>
            <SubmitButton className="self-end" pending={pending} pendingLabel={t("saving")}>
              {t("addBrand")}
            </SubmitButton>
          </SafeForm>
        ) : null}
      </Card>
    </div>
  );
}

export default function CategoriesPage() {
  return (
    <RequireAccess anyOf={[Permission.STOCK_READ]}>
      <CategoriesScreen />
    </RequireAccess>
  );
}
