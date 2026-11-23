"use client";

import { IDEMPOTENCY_HEADER, Permission, UNIT_CODES, parseQuantity, uuidv7 } from "@bizora/contracts";
import { Badge, Button, Card, FormField, PageHeader, SafeForm, Select, SubmitButton } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { BackLink } from "../../../../components/action-link";
import { type FoundProduct, ProductSearch } from "../../../../components/product-search";
import { RequireAccess } from "../../../../components/require-access";
import { useStockText, useUnitName } from "../../../../components/stock-quantity";
import { QuantityInput, SentenceInput } from "../../../../components/typing";
import { can } from "../../../../lib/access";
import { useAccess } from "../../../../lib/access-context";
import { api } from "../../../../lib/api";

type Place = { id: string; name: string; kind?: string };
type Line = { id: string; productId: string; productName: string; baseUnit: string; quantity: string; enteredQuantity: string; enteredUnit: string; receivedQuantity: string | null };
type Transfer = {
  id: string;
  number: string | null;
  status: "requested" | "approved" | "dispatched" | "received" | "cancelled";
  from: Place;
  to: Place;
  note: string | null;
  requestedAt: string;
  cancelReason: string | null;
  mine: boolean;
  lines: Line[];
};
type Draft = { product: FoundProduct; quantity: string; unit: string };

const TONE = { requested: "warning", approved: "info", dispatched: "info", received: "success", cancelled: "neutral" } as const;

/**
 * Transfers between shops and warehouses (ADR-047): ask, approve, send, receive. Stock leaves when sent and arrives
 * only when received; in between it is in transit.
 */
function TransfersScreen() {
  const t = useTranslations("stockOps");
  const access = useAccess();
  const unitName = useUnitName();
  const stockText = useStockText();
  const canApprove = can(access, Permission.STOCK_ADJUST);
  const [transfers, setTransfers] = useState<Transfer[] | null>(null);
  const [places, setPlaces] = useState<Place[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [lines, setLines] = useState<Draft[]>([]);
  const [note, setNote] = useState("");
  const [sendNow, setSendNow] = useState(true);
  const [received, setReceived] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [cancelling, setCancelling] = useState<{ id: string; reason: string } | null>(null);
  const myShop = access.membershipBranchId ?? null;

  const load = useCallback(async () => {
    const [list, shops] = await Promise.all([api("/api/v1/inventory/transfers"), api("/api/v1/stock/shops")]).catch(() => [null, null]);
    setTransfers(list?.ok ? (await list.json()).data.transfers : []);
    if (shops?.ok) setPlaces((await shops.json()).data.items ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(path: string, body: unknown, done: string) {
    setPending(true);
    setMessage(null);
    const response = await api(path, { method: "POST", headers: { [IDEMPOTENCY_HEADER]: uuidv7() }, body: JSON.stringify(body) }).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    setPending(false);
    if (!response?.ok) {
      setMessage({ tone: "error", text: response ? (payload?.error?.message ?? t("failed")) : t("needsNetwork") });
      return false;
    }
    setMessage({ tone: "ok", text: done });
    await load();
    return true;
  }

  async function create() {
    if (lines.some((line) => parseQuantity(line.quantity) === null)) return setMessage({ tone: "error", text: t("checkQuantities") });
    const ok = await act(
      "/api/v1/inventory/transfers",
      {
        id: uuidv7(),
        ...(from ? { fromBranchId: from } : {}),
        toBranchId: to,
        lines: lines.map((line) => ({ productId: line.product.id, quantity: line.quantity.trim(), unit: line.unit })),
        ...(note.trim() ? { note: note.trim() } : {}),
        dispatchNow: sendNow,
      },
      t("transferMade"),
    );
    if (ok) {
      setLines([]);
      setNote("");
    }
  }

  const at = (id: string) => !myShop || myShop === id;
  const open = (transfers ?? []).filter((row) => row.status !== "received" && row.status !== "cancelled");
  const done = (transfers ?? []).filter((row) => row.status === "received" || row.status === "cancelled");

  const card = (row: Transfer) => (
    <Card key={row.id} className="space-y-3" data-testid={`transfer-${row.number}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium">
          {row.number} · {t("fromTo", { from: row.from.name, to: row.to.name })}
        </p>
        <Badge tone={TONE[row.status]}>{t(`status.${row.status}`)}</Badge>
      </div>
      <ul className="space-y-2 text-sm">
        {row.lines.map((line) => (
          <li key={line.id} className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {line.productName}: {stockText(line.quantity, line.baseUnit)}
              {line.receivedQuantity !== null && line.receivedQuantity !== line.quantity ? ` · ${t("arrived", { quantity: stockText(line.receivedQuantity, line.baseUnit) })}` : null}
            </span>
            {row.status === "dispatched" && at(row.to.id) ? (
              <FormField id={`received-${line.id}`} label={t("howManyArrived", { unit: unitName(line.enteredUnit, 2) })}>
                <QuantityInput
                  id={`received-${line.id}`}
                  className="w-28"
                  placeholder={(BigInt(line.enteredQuantity) / 1000n).toString()}
                  value={received[line.id] ?? ""}
                  onChange={(event) => setReceived({ ...received, [line.id]: event.target.value })}
                />
              </FormField>
            ) : null}
          </li>
        ))}
      </ul>
      {row.note ? <p className="text-sm text-muted">{row.note}</p> : null}
      {row.cancelReason ? <p className="text-sm text-muted">{t("cancelledBecause", { reason: row.cancelReason })}</p> : null}
      <div className="flex flex-wrap gap-2">
        {row.status === "requested" && canApprove && at(row.from.id) ? (
          <Button type="button" disabled={pending} onClick={() => void act(`/api/v1/inventory/transfers/${row.id}/approve`, {}, t("approved"))}>
            {t("approve")}
          </Button>
        ) : null}
        {row.status === "approved" && at(row.from.id) ? (
          <Button type="button" disabled={pending} onClick={() => void act(`/api/v1/inventory/transfers/${row.id}/dispatch`, {}, t("sent"))}>
            {t("send")}
          </Button>
        ) : null}
        {row.status === "dispatched" && at(row.to.id) ? (
          <Button
            type="button"
            disabled={pending}
            onClick={() =>
              void act(
                `/api/v1/inventory/transfers/${row.id}/receive`,
                { lines: row.lines.filter((line) => (received[line.id] ?? "").trim()).map((line) => ({ lineId: line.id, receivedQuantity: (received[line.id] ?? "").trim() })) },
                t("receivedDone"),
              )
            }
          >
            {t("receive")}
          </Button>
        ) : null}
        {(row.status === "requested" || row.status === "approved") && (row.mine || canApprove) ? (
          cancelling?.id === row.id ? (
            <SafeForm
              className="flex w-full flex-wrap items-end gap-2"
              pending={pending}
              onSubmit={() =>
                void act(`/api/v1/inventory/transfers/${row.id}/cancel`, { reason: cancelling.reason.trim() }, t("cancelled")).then((ok) => {
                  if (ok) setCancelling(null);
                })
              }
            >
              <FormField id={`cancel-${row.id}`} label={t("cancelWhy")}>
                <SentenceInput id={`cancel-${row.id}`} value={cancelling.reason} onChange={(event) => setCancelling({ id: row.id, reason: event.target.value })} minLength={3} maxLength={240} required />
              </FormField>
              <SubmitButton pending={pending} pendingLabel={t("saving")}>
                {t("cancel")}
              </SubmitButton>
            </SafeForm>
          ) : (
            <Button type="button" variant="ghost" disabled={pending} onClick={() => setCancelling({ id: row.id, reason: "" })}>
              {t("cancel")}
            </Button>
          )
        ) : null}
      </div>
    </Card>
  );

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <BackLink href="/app/stock">{t("back")}</BackLink>
      <PageHeader title={t("transfersTitle")} intro={t("transfersLead")} />
      {message ? (
        <p className={`text-sm ${message.tone === "error" ? "text-danger" : "text-success"}`} role={message.tone === "error" ? "alert" : "status"}>
          {message.text}
        </p>
      ) : null}

      {can(access, Permission.STOCK_TRANSFER) ? (
        <Card className="space-y-4">
          <h2 className="text-lg font-semibold">{t("newTransfer")}</h2>
          <SafeForm className="space-y-4" pending={pending} onSubmit={() => void create()}>
            {!myShop ? (
              <FormField id="transfer-from" label={t("from")}>
                <Select id="transfer-from" value={from} onChange={(event) => setFrom(event.target.value)} required={!access.branchId}>
                  <option value="">{access.branchId ? t("thisShop") : t("choosePlace")}</option>
                  {places.map((place) => (
                    <option key={place.id} value={place.id}>
                      {place.name}
                    </option>
                  ))}
                </Select>
              </FormField>
            ) : null}
            <FormField id="transfer-to" label={t("to")}>
              <Select id="transfer-to" value={to} onChange={(event) => setTo(event.target.value)} required>
                <option value="">{t("choosePlace")}</option>
                {places
                  .filter((place) => place.id !== (from || myShop || access.branchId))
                  .map((place) => (
                    <option key={place.id} value={place.id}>
                      {place.name}
                    </option>
                  ))}
              </Select>
            </FormField>
            <ProductSearch id="transfer-product" branchId={from || myShop || access.branchId} onPick={(product) => setLines(lines.some((line) => line.product.id === product.id) ? lines : [...lines, { product, quantity: "", unit: product.baseUnit }])} />
            {lines.map((line, index) => (
              <div key={line.product.id} className="grid grid-cols-[1fr_6rem_7rem_auto] items-end gap-2">
                <p className="text-sm">{line.product.name}</p>
                <FormField id={`line-qty-${index}`} label={t("quantity")}>
                  <QuantityInput id={`line-qty-${index}`} value={line.quantity} onChange={(event) => setLines(lines.map((item, i) => (i === index ? { ...item, quantity: event.target.value } : item)))} required />
                </FormField>
                <FormField id={`line-unit-${index}`} label={t("unit")}>
                  <Select id={`line-unit-${index}`} value={line.unit} onChange={(event) => setLines(lines.map((item, i) => (i === index ? { ...item, unit: event.target.value } : item)))}>
                    {[line.product.baseUnit, ...line.product.packs.map((pack) => pack.unitCode)]
                      .filter((code) => (UNIT_CODES as readonly string[]).includes(code))
                      .map((code) => (
                        <option key={code} value={code}>
                          {unitName(code, 2)}
                        </option>
                      ))}
                  </Select>
                </FormField>
                <Button type="button" variant="ghost" onClick={() => setLines(lines.filter((_, i) => i !== index))}>
                  {t("remove")}
                </Button>
              </div>
            ))}
            <FormField id="transfer-note" label={t("note")} hint={t("optional")}>
              <SentenceInput id="transfer-note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={240} />
            </FormField>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" checked={sendNow} onChange={(event) => setSendNow(event.target.checked)} />
              {t("sendNow")}
            </label>
            <SubmitButton pending={pending} pendingLabel={t("saving")} disabled={!to || lines.length === 0}>
              {t("makeTransfer")}
            </SubmitButton>
          </SafeForm>
        </Card>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t("waiting")}</h2>
        {transfers === null ? null : open.length === 0 ? <p className="text-sm text-muted">{t("noneWaiting")}</p> : open.map(card)}
      </section>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t("finished")}</h2>
        {transfers === null ? null : done.length === 0 ? <p className="text-sm text-muted">{t("noneFinished")}</p> : done.slice(0, 20).map(card)}
      </section>
    </div>
  );
}

export default function TransfersPage() {
  return (
    <RequireAccess anyOf={[Permission.STOCK_TRANSFER, Permission.STOCK_RECEIVE, Permission.STOCK_ADJUST]}>
      <TransfersScreen />
    </RequireAccess>
  );
}
