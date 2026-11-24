"use client";

import { capitaliseFirst, FLEXIBLE_UNIT } from "@bizora/contracts";
import { Button, FormField, Input } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { api } from "../lib/api";

type ShopUnit = { id?: string; code: string; displayName: string; standard?: boolean };

/** Units this shop sells in, beside the usual list (ADR-053). The owner can add one here; a typed unit waits for a second sale. */
export function BusinessUnits() {
  const t = useTranslations("settings.units");
  const [units, setUnits] = useState<ShopUnit[] | null>(null);
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function load() {
    const response = await api("/api/v1/units").catch(() => null);
    if (!response?.ok) return setProblem(t("loadFailed"));
    const body = (await response.json()) as { data: { units: ShopUnit[] } };
    setUnits(body.data.units.filter((unit) => unit.standard === false && unit.id));
    setProblem(null);
  }

  useEffect(() => {
    void load();
  }, []);

  async function add() {
    const next = code.trim().toLowerCase();
    setProblem(null);
    if (!FLEXIBLE_UNIT.test(next)) return setProblem(t("invalid"));
    setPending(true);
    try {
      const response = await api("/api/v1/units", {
        method: "POST",
        body: JSON.stringify({ code: next, displayName: capitaliseFirst(next) }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        setProblem(payload?.error?.message ?? t("addFailed"));
        return;
      }
      setCode("");
      await load();
    } catch {
      setProblem(t("addFailed"));
    } finally {
      setPending(false);
    }
  }

  async function turnOff(unit: ShopUnit) {
    if (!unit.id) return;
    setProblem(null);
    const response = await api(`/api/v1/units/${unit.id}`, { method: "PATCH", body: JSON.stringify({ active: false }) }).catch(() => null);
    if (!response?.ok) {
      const payload = response ? ((await response.json().catch(() => null)) as { error?: { message?: string } } | null) : null;
      setProblem(payload?.error?.message ?? t("turnOffFailed"));
      return;
    }
    setUnits((current) => current?.filter((known) => known.id !== unit.id) ?? null);
  }

  const custom = units ?? [];

  return (
    <div className="space-y-2 rounded-card border border-border p-3" data-testid="business-units">
      <p className="text-sm font-medium">{t("title")}</p>
      <p className="text-xs text-muted">{t("lead")}</p>
      {problem ? (
        <p className="text-sm text-danger" role="alert">
          {problem}
        </p>
      ) : null}
      {custom.length > 0 ? (
        <ul className="divide-y divide-border">
          {custom.map((unit) => (
            <li key={unit.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="font-medium">{unit.displayName}</span>
              <Button type="button" variant="secondary" onClick={() => void turnOff(unit)}>
                {t("turnOff")}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-end gap-2">
        <FormField id="settings-unit" label={t("code")}>
          <Input
            id="settings-unit"
            value={code}
            maxLength={16}
            autoCapitalize="none"
            onChange={(event) => setCode(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void add();
              }
            }}
          />
        </FormField>
        <Button type="button" disabled={pending || code.trim().length === 0} onClick={() => void add()}>
          {t("add")}
        </Button>
      </div>
    </div>
  );
}
