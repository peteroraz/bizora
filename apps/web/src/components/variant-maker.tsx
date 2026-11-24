"use client";

import { IDEMPOTENCY_HEADER, parseAmount, uuidv7 } from "@bizora/contracts";
import { Button, Card, FormField } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { problemOf } from "../lib/money-client";
import { AmountInput } from "./typing";

type Attribute = { id: string; name: string; kind: string; active: boolean; options: { id: string; value: string; active: boolean }[] };

/**
 * Make variants from attributes (ADR-060): tick the choices ("Red, Black" and "S, M, L"), see the list, then make them.
 * Combinations that already exist are left alone. Loaded on the product page for people who manage products.
 */
export default function VariantMaker({ itemId, itemName, currency, onMade }: { itemId: string; itemName: string; currency: string; onMade: () => void }) {
  const t = useTranslations("attributes.maker");
  const [attributes, setAttributes] = useState<Attribute[]>([]);
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [price, setPrice] = useState("");
  const [preview, setPreview] = useState<{ wouldMake: string[]; skipped: string[] } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    void api("/api/v1/catalog/attributes")
      .then(async (response) => (response.ok ? ((await response.json()) as { data: { items: Attribute[] } }).data.items : []))
      .then((items) => setAttributes(items.filter((item) => item.active && item.kind === "select" && item.options.length > 0)))
      .catch(() => undefined);
  }, []);

  const picked = Object.entries(chosen)
    .filter(([, ids]) => ids.length > 0)
    .map(([attributeId, optionIds]) => ({ attributeId, optionIds }));

  async function run(dryRun: boolean) {
    setError(null);
    setNotice(null);
    const priceMinor = price.trim() ? parseAmount(price, currency) : null;
    if (price.trim() && priceMinor === null) {
      setError(t("badPrice"));
      return;
    }
    setPending(true);
    try {
      const response = await api(`/api/v1/catalog/items/${itemId}/generate-variants`, {
        method: "POST",
        headers: { [IDEMPOTENCY_HEADER]: uuidv7() },
        body: JSON.stringify({ attributes: picked, dryRun, ...(priceMinor !== null ? { priceMinor: priceMinor.toString() } : {}) }),
      });
      if (!response.ok) {
        setError(await problemOf(response, t("failed")));
        return;
      }
      const data = ((await response.json()) as { data: { wouldMake: string[]; skipped: string[]; made: { id: string; name: string }[] } }).data;
      if (dryRun) {
        setPreview(data);
        return;
      }
      setNotice(t("made", { count: data.made.length }));
      setPreview(null);
      setChosen({});
      onMade();
    } catch {
      setError(t("failed"));
    } finally {
      setPending(false);
    }
  }

  if (attributes.length === 0) return null;
  return (
    <Card className="space-y-4" data-testid="variant-maker">
      <div>
        <p className="font-medium">{t("title")}</p>
        <p className="text-sm text-muted">{t("lead", { name: itemName })}</p>
      </div>
      {attributes.map((attribute) => (
        <fieldset key={attribute.id} className="space-y-1">
          <legend className="text-sm font-medium">{attribute.name}</legend>
          <div className="flex flex-wrap gap-2">
            {attribute.options
              .filter((option) => option.active)
              .map((option) => {
                const on = (chosen[attribute.id] ?? []).includes(option.id);
                return (
                  <label key={option.id} className={`inline-flex min-h-11 items-center gap-2 rounded-control border px-3 text-sm ${on ? "border-primary" : "border-border"}`}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => {
                        setPreview(null);
                        setChosen((was) => {
                          const list = was[attribute.id] ?? [];
                          return { ...was, [attribute.id]: on ? list.filter((id) => id !== option.id) : [...list, option.id] };
                        });
                      }}
                    />
                    {option.value}
                  </label>
                );
              })}
          </div>
        </fieldset>
      ))}
      <FormField id="variant-maker-price" label={t("price")} hint={t("priceHint")}>
        <AmountInput id="variant-maker-price" currency={currency} value={price} onChange={(event) => setPrice(event.target.value)} />
      </FormField>
      {error ? (
        <p className="text-sm font-medium text-danger" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="text-sm text-success" role="status">
          {notice}
        </p>
      ) : null}
      {preview ? (
        <div className="space-y-1 text-sm" data-testid="variant-preview">
          {preview.wouldMake.length > 0 ? <p className="font-medium">{t("willMake", { count: preview.wouldMake.length })}</p> : <p>{t("nothingNew")}</p>}
          <ul className="list-disc pl-5">
            {preview.wouldMake.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
          {preview.skipped.length > 0 ? <p className="text-muted">{t("alreadyThere", { count: preview.skipped.length })}</p> : null}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={pending || picked.length === 0} onClick={() => void run(true)}>
          {t("check")}
        </Button>
        <Button type="button" disabled={pending || !preview || preview.wouldMake.length === 0} onClick={() => void run(false)}>
          {t("make", { count: preview?.wouldMake.length ?? 0 })}
        </Button>
      </div>
    </Card>
  );
}
