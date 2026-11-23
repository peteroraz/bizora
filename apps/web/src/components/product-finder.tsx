"use client";

import { Button, Input } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { api } from "../lib/api";

export type FoundProduct = { id: string; name: string; baseUnit: string; packs: { unitCode: string }[]; priceMinor: string | null };

/** Finds a product by name, barcode or a supplier's code, and hands back the one tapped (ADR-048). */
export function ProductFinder({ id, onPick }: { id: string; onPick: (product: FoundProduct) => void }) {
  const t = useTranslations("pricing");
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<FoundProduct[] | null>(null);

  async function search() {
    const text = query.trim();
    if (!text) return;
    const response = await api(`/api/v1/products?q=${encodeURIComponent(text)}`).catch(() => null);
    setFound(response?.ok ? (((await response.json()) as { data: { items: FoundProduct[] } }).data.items ?? []) : []);
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          id={id}
          value={query}
          placeholder={t("findProduct")}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void search();
            }
          }}
        />
        <Button type="button" variant="outline" onClick={() => void search()}>
          {t("find")}
        </Button>
      </div>
      {found && found.length === 0 ? <p className="text-sm text-muted">{t("noProduct")}</p> : null}
      {found && found.length > 0 ? (
        <ul className="divide-y divide-border rounded-card border border-border">
          {found.slice(0, 8).map((product) => (
            <li key={product.id}>
              <button
                type="button"
                className="min-h-11 w-full px-3 py-2 text-left text-sm hover:bg-input"
                onClick={() => {
                  onPick(product);
                  setFound(null);
                  setQuery("");
                }}
              >
                {product.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
