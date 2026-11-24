"use client";

import { COUNT_REASONS, IDEMPOTENCY_HEADER, Permission, parseCountQuantity, uuidv7 } from "@bizora/contracts";
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
import { enqueue } from "../../../../lib/offline/outbox";
import { isNetworkFailure } from "../../../../lib/offline/sync";

type Line = { id: string; productId: string; productName: string; baseUnit: string; systemQuantity: string; countedQuantity: string; difference: string; reason: string | null; note: string | null };
type Session = {
  id: string;
  name: string;
  status: "draft" | "counting" | "submitted" | "approved" | "posted" | "cancelled";
  branch: { id: string; name: string };
  decisionNote: string | null;
  counted: number;
  withDifference: number;
  mine: boolean;
  lines?: Line[];
};

const TONE = { draft: "neutral", counting: "info", submitted: "warning", approved: "info", posted: "success", cancelled: "neutral" } as const;

/**
 * Count sessions (ADR-047): count many products, submit, and a manager approves. Only then are the differences
 * applied to stock, as count movements; nothing already recorded changes.
 */
function CountsScreen() {
  const t = useTranslations("stockOps");
  const access = useAccess();
  const unitName = useUnitName();
  const stockText = useStockText();
  const canApprove = can(access, Permission.STOCK_ADJUST);
  const canCount = can(access, Permission.STOCK_COUNT);
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [open, setOpen] = useState<Session | null>(null);
  const [name, setName] = useState("");
  // With "All shops" selected, the count says which shop it is for.
  const [shopId, setShopId] = useState("");
  const [shops, setShops] = useState<{ id: string; name: string }[]>([]);
  const needsShop = !access.branchId && !access.membershipBranchId;
  const [picked, setPicked] = useState<FoundProduct | null>(null);
  const [counted, setCounted] = useState("");
  const [unit, setUnit] = useState("piece");
  const [reason, setReason] = useState("");
  const [lineNote, setLineNote] = useState("");
  const [rejectNote, setRejectNote] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(async (keep?: string) => {
    const response = await api("/api/v1/inventory/counts").catch(() => null);
    setSessions(response?.ok ? (await response.json()).data.counts : []);
    if (keep) {
      const one = await api(`/api/v1/inventory/counts/${keep}`).catch(() => null);
      if (one?.ok) setOpen((await one.json()).data.count);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!needsShop) return;
    void api("/api/v1/stock/shops")
      .then(async (response) => (response.ok ? setShops((await response.json()).data.items ?? []) : undefined))
      .catch(() => undefined);
  }, [needsShop]);

  async function send(path: string, body: unknown, done: string) {
    setPending(true);
    setMessage(null);
    const response = await api(path, { method: "POST", headers: { [IDEMPOTENCY_HEADER]: uuidv7() }, body: JSON.stringify(body) }).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    setPending(false);
    if (!response?.ok) {
      setMessage({ tone: "error", text: response ? (payload?.error?.message ?? t("failed")) : t("needsNetwork") });
      return null;
    }
    setMessage({ tone: "ok", text: done });
    const session = payload.data.count as Session;
    setOpen(session);
    await load();
    return session;
  }

  // A line counted with no network waits on this phone and is sent later, compared with the stock at the time it
  // was counted (ADR-064). The ones waiting are shown under the count until they are sent.
  const [waiting, setWaiting] = useState<{ sessionId: string; name: string; text: string }[]>([]);
  async function countLine(sessionId: string, body: Record<string, unknown>, name: string, text: string) {
    setPending(true);
    setMessage(null);
    try {
      return await sendLine(sessionId, body, name, text);
    } finally {
      setPending(false);
    }
  }
  async function sendLine(sessionId: string, body: Record<string, unknown>, name: string, text: string) {
    try {
      if (typeof navigator !== "undefined" && navigator.onLine === false) throw new TypeError("offline");
      const response = await api(`/api/v1/inventory/counts/${sessionId}/lines`, { method: "POST", headers: { [IDEMPOTENCY_HEADER]: uuidv7() }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setMessage({ tone: "error", text: payload?.error?.message ?? t("failed") });
        return false;
      }
      setMessage({ tone: "ok", text: t("countSaved") });
      setOpen(payload.data.count as Session);
      await load();
      return true;
    } catch (error) {
      if (!access.owner || !isNetworkFailure(error)) {
        setMessage({ tone: "error", text: t("failed") });
        return false;
      }
      await enqueue(access.owner, "stock.count_line", { sessionId, ...body });
      setWaiting((current) => [...current, { sessionId, name, text }]);
      setMessage({ tone: "ok", text: t("countSavedOffline") });
      return true;
    }
  }

  const differenceText = (line: Line) => {
    const value = BigInt(line.difference);
    if (value === 0n) return t("matches");
    return value > 0n ? t("over", { quantity: stockText(line.difference, line.baseUnit) }) : t("short", { quantity: stockText((-value).toString(), line.baseUnit) });
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <BackLink href="/app/stock">{t("back")}</BackLink>
      <PageHeader title={t("countsTitle")} intro={t("countsLead")} />
      {message ? (
        <p className={`text-sm ${message.tone === "error" ? "text-danger" : "text-success"}`} role={message.tone === "error" ? "alert" : "status"}>
          {message.text}
        </p>
      ) : null}

      {open ? (
        <Card className="space-y-4" data-testid="count-session">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold">
              {open.name} · {open.branch.name}
            </h2>
            <Badge tone={TONE[open.status]}>{t(`countStatus.${open.status}`)}</Badge>
          </div>
          {open.decisionNote && open.status === "counting" ? <p className="text-sm text-warning">{t("sentBack", { note: open.decisionNote })}</p> : null}
          <ul className="divide-y divide-border text-sm" data-testid="count-lines">
            {(open.lines ?? []).map((line) => (
              <li key={line.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {line.productName}: {t("countedOf", { counted: stockText(line.countedQuantity, line.baseUnit), expected: stockText(line.systemQuantity, line.baseUnit) })}
                </span>
                <span className={BigInt(line.difference) === 0n ? "text-muted" : "font-medium"}>
                  {differenceText(line)}
                  {line.reason ? ` · ${t(`reasons.${line.reason}`)}` : ""}
                </span>
              </li>
            ))}
            {waiting
              .filter((item) => item.sessionId === open.id)
              .map((item, index) => (
                <li key={`waiting-${index}`} className="flex flex-wrap items-center justify-between gap-2 py-2 text-muted" data-testid="count-line-waiting">
                  <span>
                    {item.name}: {item.text}
                  </span>
                  <Badge tone="warning">{t("waitingToSend")}</Badge>
                </li>
              ))}
          </ul>
          {open.status === "counting" && canCount ? (
            <SafeForm
              className="space-y-3"
              pending={pending}
              onSubmit={() => {
                if (!picked || parseCountQuantity(counted) === null) return setMessage({ tone: "error", text: t("checkQuantities") });
                void countLine(
                  open.id,
                  { productId: picked.id, countedQuantity: counted.trim(), unit, ...(reason ? { reason } : {}), ...(lineNote.trim() ? { note: lineNote.trim() } : {}) },
                  picked.name,
                  `${counted.trim()} ${unitName(unit, 2)}`,
                ).then((saved) => {
                  if (saved) {
                    setPicked(null);
                    setCounted("");
                    setReason("");
                    setLineNote("");
                  }
                });
              }}
            >
              {picked ? (
                <p className="text-sm">
                  {picked.name}{" "}
                  <Button type="button" variant="ghost" onClick={() => setPicked(null)}>
                    {t("change")}
                  </Button>
                </p>
              ) : (
                <ProductSearch
                  id="count-product"
                  branchId={open.branch.id}
                  onPick={(product) => {
                    setPicked(product);
                    setUnit(product.baseUnit);
                  }}
                />
              )}
              {picked ? (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <FormField id="count-qty" label={t("howManyCounted")}>
                      <QuantityInput id="count-qty" value={counted} onChange={(event) => setCounted(event.target.value)} required />
                    </FormField>
                    <FormField id="count-unit" label={t("unit")}>
                      <Select id="count-unit" value={unit} onChange={(event) => setUnit(event.target.value)}>
                        {[picked.baseUnit, ...picked.packs.map((pack) => pack.unitCode)].map((code) => (
                          <option key={code} value={code}>
                            {unitName(code, 2)}
                          </option>
                        ))}
                      </Select>
                    </FormField>
                  </div>
                  <FormField id="count-reason" label={t("reasonIfDifferent")} hint={t("optional")}>
                    <Select id="count-reason" value={reason} onChange={(event) => setReason(event.target.value)}>
                      <option value="">{t("reasons.count_correction")}</option>
                      {COUNT_REASONS.filter((code) => code !== "count_correction").map((code) => (
                        <option key={code} value={code}>
                          {t(`reasons.${code}`)}
                        </option>
                      ))}
                    </Select>
                  </FormField>
                  <FormField id="count-note" label={t("note")} hint={t("optional")}>
                    <SentenceInput id="count-note" value={lineNote} onChange={(event) => setLineNote(event.target.value)} maxLength={240} />
                  </FormField>
                  <SubmitButton pending={pending} pendingLabel={t("saving")}>
                    {t("saveCount")}
                  </SubmitButton>
                </>
              ) : null}
            </SafeForm>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {open.status === "counting" && canCount && (open.lines ?? []).length > 0 ? (
              <Button type="button" disabled={pending} onClick={() => void send(`/api/v1/inventory/counts/${open.id}/submit`, {}, t("submitted"))}>
                {t("submit")}
              </Button>
            ) : null}
            {open.status === "submitted" && canApprove ? (
              <>
                <Button type="button" disabled={pending} onClick={() => void send(`/api/v1/inventory/counts/${open.id}/approve`, {}, t("posted"))}>
                  {t("approveCount")}
                </Button>
                <SafeForm
                  className="flex flex-wrap items-end gap-2"
                  pending={pending}
                  onSubmit={() => void send(`/api/v1/inventory/counts/${open.id}/reject`, { note: rejectNote.trim() }, t("returned")).then(() => setRejectNote(""))}
                >
                  <FormField id="count-reject" label={t("sendBackWhy")}>
                    <SentenceInput id="count-reject" value={rejectNote} onChange={(event) => setRejectNote(event.target.value)} minLength={3} maxLength={240} required />
                  </FormField>
                  <SubmitButton variant="secondary" pending={pending} pendingLabel={t("saving")}>
                    {t("sendBack")}
                  </SubmitButton>
                </SafeForm>
              </>
            ) : null}
            <Button type="button" variant="ghost" onClick={() => setOpen(null)}>
              {t("close")}
            </Button>
          </div>
        </Card>
      ) : null}

      {canCount && !open ? (
        <Card>
          <SafeForm
            className="flex flex-wrap items-end gap-2"
            pending={pending}
            onSubmit={() => void send("/api/v1/inventory/counts", { id: uuidv7(), name: name.trim(), ...(shopId ? { branchId: shopId } : {}) }, t("countStarted")).then((session) => session && setName(""))}
          >
            {needsShop ? (
              <FormField id="count-shop" label={t("countWhere")}>
                <Select id="count-shop" value={shopId} onChange={(event) => setShopId(event.target.value)} required>
                  <option value="">{t("choosePlace")}</option>
                  {shops.map((shop) => (
                    <option key={shop.id} value={shop.id}>
                      {shop.name}
                    </option>
                  ))}
                </Select>
              </FormField>
            ) : null}
            <FormField id="count-name" label={t("countName")}>
              <SentenceInput id="count-name" value={name} onChange={(event) => setName(event.target.value)} placeholder={t("countNameExample")} required maxLength={80} />
            </FormField>
            <SubmitButton pending={pending} pendingLabel={t("saving")}>
              {t("startCount")}
            </SubmitButton>
          </SafeForm>
        </Card>
      ) : null}

      <ul className="space-y-2">
        {(sessions ?? []).map((session) => (
          <li key={session.id}>
            <button type="button" className="flex min-h-11 w-full items-center justify-between gap-2 rounded-control border border-border px-3 text-left text-sm" onClick={() => void load(session.id)}>
              <span>
                {session.name} · {session.branch.name} · {t("linesCounted", { count: session.counted, different: session.withDifference })}
              </span>
              <Badge tone={TONE[session.status]}>{t(`countStatus.${session.status}`)}</Badge>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function CountsPage() {
  return (
    <RequireAccess anyOf={[Permission.STOCK_COUNT, Permission.STOCK_ADJUST]}>
      <CountsScreen />
    </RequireAccess>
  );
}
