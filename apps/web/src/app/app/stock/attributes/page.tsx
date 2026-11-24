"use client";

import { ATTRIBUTE_KINDS, IDEMPOTENCY_HEADER, Permission, uuidv7, type AttributeKind } from "@bizora/contracts";
import { Button, Card, FormField, Input, PageHeader } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { BackLink } from "../../../../components/action-link";
import { RequireAccess } from "../../../../components/require-access";
import { api } from "../../../../lib/api";
import { problemOf } from "../../../../lib/money-client";

export type Attribute = { id: string; name: string; kind: AttributeKind; unit: string | null; active: boolean; options: { id: string; value: string; active: boolean }[] };

/** Choices typed as "Red, Black, Navy blue" or one per line. */
const splitChoices = (text: string) => text.split(/[,\n]/).map((part) => part.trim()).filter(Boolean);

/**
 * The business's own attributes (ADR-060): Colour, Size, Storage, Make… A list attribute has choices, which can make
 * variants on a product's page.
 */
function AttributesScreen() {
  const t = useTranslations("attributes");
  const [items, setItems] = useState<Attribute[] | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<AttributeKind>("select");
  const [choices, setChoices] = useState("");
  const [unit, setUnit] = useState("");
  const [more, setMore] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    const response = await api("/api/v1/catalog/attributes").catch(() => null);
    if (response?.ok) setItems(((await response.json()) as { data: { items: Attribute[] } }).data.items);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Saves, then clears the form (`onOk`) and reloads before saying it worked, so the next entry starts clean. */
  async function send(path: string, method: string, body: unknown, done: string, onOk?: () => void) {
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      const response = await api(path, { method, headers: { [IDEMPOTENCY_HEADER]: uuidv7() }, body: JSON.stringify(body) });
      if (!response.ok) {
        setError(await problemOf(response, t("failed")));
        return false;
      }
      onOk?.();
      await load();
      setNotice(done);
      return true;
    } catch {
      setError(t("failed"));
      return false;
    } finally {
      setPending(false);
    }
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    const list = kind === "select" || kind === "multi_select";
    await send(
      "/api/v1/catalog/attributes",
      "POST",
      { name: name.trim(), kind, ...(list ? { options: splitChoices(choices) } : {}), ...(kind === "number" && unit.trim() ? { unit: unit.trim() } : {}) },
      t("added", { name: name.trim() }),
      () => {
        setName("");
        setChoices("");
        setUnit("");
      },
    );
  }

  return (
    <div className="space-y-6">
      <BackLink href="/app/stock">{t("back")}</BackLink>
      <PageHeader title={t("title")} intro={t("lead")} />
      {notice ? (
        <p className="rounded-card border border-success bg-success-bg px-4 py-3 text-sm text-success" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="text-sm font-medium text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <Card>
        <form className="space-y-4" onSubmit={(event) => void add(event)}>
          <FormField id="attribute-name" label={t("name")} hint={t("nameHint")}>
            <Input id="attribute-name" value={name} maxLength={60} required onChange={(event) => setName(event.target.value)} />
          </FormField>
          <FormField id="attribute-kind" label={t("kind")}>
            <select id="attribute-kind" className="h-11 w-full rounded-control border border-border bg-input px-2 text-sm" value={kind} onChange={(event) => setKind(event.target.value as AttributeKind)}>
              {ATTRIBUTE_KINDS.map((option) => (
                <option key={option} value={option}>
                  {t(`kinds.${option}`)}
                </option>
              ))}
            </select>
          </FormField>
          {kind === "select" || kind === "multi_select" ? (
            <FormField id="attribute-choices" label={t("choices")} hint={t("choicesHint")}>
              <Input id="attribute-choices" value={choices} onChange={(event) => setChoices(event.target.value)} />
            </FormField>
          ) : null}
          {kind === "number" ? (
            <FormField id="attribute-unit" label={t("unit")} hint={t("unitHint")}>
              <Input id="attribute-unit" value={unit} maxLength={16} onChange={(event) => setUnit(event.target.value)} />
            </FormField>
          ) : null}
          <Button type="submit" disabled={pending || !name.trim()}>
            {t("add")}
          </Button>
        </form>
      </Card>
      {items && items.length === 0 ? <p className="text-sm text-muted">{t("none")}</p> : null}
      <ul className="space-y-3" data-testid="attribute-list">
        {(items ?? []).map((item) => (
          <li key={item.id}>
            <Card className={`space-y-3 ${item.active ? "" : "opacity-70"}`}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-medium">{item.name}</p>
                  <p className="text-sm text-muted">
                    {t(`kinds.${item.kind}`)}
                    {item.unit ? ` (${item.unit})` : ""}
                  </p>
                </div>
                <Button type="button" variant="ghost" disabled={pending} onClick={() => void send(`/api/v1/catalog/attributes/${item.id}`, "PATCH", { active: !item.active }, item.active ? t("turnedOff", { name: item.name }) : t("turnedOn", { name: item.name }))}>
                  {item.active ? t("turnOff") : t("turnOn")}
                </Button>
              </div>
              {item.options.length > 0 ? <p className="text-sm">{item.options.map((option) => option.value).join(", ")}</p> : null}
              {item.kind === "select" || item.kind === "multi_select" ? (
                <form
                  className="flex gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const text = more[item.id] ?? "";
                    void send(`/api/v1/catalog/attributes/${item.id}`, "PATCH", { addOptions: splitChoices(text) }, t("choicesAdded", { name: item.name }), () => setMore((was) => ({ ...was, [item.id]: "" })));
                  }}
                >
                  <Input aria-label={t("moreChoices", { name: item.name })} placeholder={t("moreChoicesPlaceholder")} value={more[item.id] ?? ""} onChange={(event) => setMore((was) => ({ ...was, [item.id]: event.target.value }))} />
                  <Button type="submit" variant="outline" disabled={pending || !(more[item.id] ?? "").trim()}>
                    {t("addChoices")}
                  </Button>
                </form>
              ) : null}
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function AttributesPage() {
  return (
    <RequireAccess anyOf={[Permission.PRODUCTS_MANAGE]}>
      <AttributesScreen />
    </RequireAccess>
  );
}
