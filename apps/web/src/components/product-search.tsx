"use client";

import { Button, FormField, Input } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { api } from "../lib/api";
import { useStockText } from "./stock-quantity";

export type FoundProduct = { id: string; name: string; baseUnit: string; packs: { unitCode: string; baseQuantity: string }[]; stock: { quantity: string } };

/** Find a product by name or code, for transfer and count lines. Searches the server; nothing is preloaded. */
/** `branchId`: whose stock to show; needed when no shop is selected ("All shops"). */
export function ProductSearch({ id, onPick, branchId }: { id: string; onPick: (product: FoundProduct) => void; branchId?: string | null }) {
  const t = useTranslations("stockOps");
  const stockText = useStockText();
  const [q, setQ] = useState("");
  const [found, setFound] = useState<FoundProduct[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function search() {
    if (!q.trim()) return;
    setProblem(null);
    const response = await api(`/api/v1/products?q=${encodeURIComponent(q.trim())}${branchId ? `&branchId=${branchId}` : ""}`).catch(() => null);
    if (!response) return setProblem(t("needsNetwork"));
    if (!response.ok) return setProblem(t("failed"));
    setFound(((await response.json()).data.items as FoundProduct[]).filter((item) => item.stock));
  }

  return (
    <div className="space-y-2">
      <div className="flex items-end gap-2">
        <FormField id={id} label={t("findProduct")}>
          <Input
            id={id}
            value={q}
            onChange={(event) => setQ(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void search();
              }
            }}
          />
        </FormField>
        <Button type="button" variant="secondary" onClick={() => void search()}>
          {t("find")}
        </Button>
      </div>
      {problem ? <p className="text-sm text-danger">{problem}</p> : null}
      {found ? (
        found.length === 0 ? (
          <p className="text-sm text-muted">{t("noneFound")}</p>
        ) : (
          <ul className="divide-y divide-border rounded-control border border-border">
            {found.slice(0, 8).map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="flex min-h-11 w-full items-center justify-between gap-3 px-3 text-left text-sm"
                  onClick={() => {
                    onPick(item);
                    setFound(null);
                    setQ("");
                  }}
                >
                  <span>{item.name}</span>
                  <span className="text-muted">{stockText(item.stock.quantity, item.baseUnit, item.packs)}</span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
