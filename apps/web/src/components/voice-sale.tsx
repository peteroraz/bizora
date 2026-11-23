"use client";

import { amountText, parseAmount, parseQuantity, quantityToString, type CaptureResult } from "@bizora/contracts";
import {
  blocking,
  buildReview,
  checkReview,
  parseSpokenSale,
  speechPrompt,
  priceLine,
  rank,
  sellingUnitsOf,
  type ReviewCustomer,
  type ReviewLine,
  type ReviewWarning,
  type SaleReview,
} from "@bizora/contracts/voice";
import { Button, Card, FormField, Input, Select, Textarea } from "@bizora/ui";
import { Mic } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatCurrency } from "../i18n/format";
import type { CachedProduct } from "../lib/offline/catalog";
import { readCustomerDirectory, refreshCustomerDirectory, type DirectoryCustomer } from "../lib/offline/customers";
import type { OutboxOwner } from "../lib/offline/outbox";
import { cleanUp, tidyWords } from "../lib/voice/clean";
import { track } from "../lib/pilot-events";
import { detectSupport, downloadSize, engine, install, installState, prepare, VoiceError, type InstallState, type Support } from "../lib/voice/engine";
import { MAX_SECONDS, startRecording, type Recording } from "../lib/voice/recorder";
import { CaptureBar } from "./capture-bar";
import { useUnitName } from "./stock-quantity";

export type VoicePayment = { method: "cash" | "transfer" | "pos"; amountMinor: bigint };
export type VoiceResult = {
  lines: { product: CachedProduct; unit: string; quantity: string; price: string }[];
  customer: { id: string; name: string; credit: { allowed: boolean; limitMinor: string | null } } | null;
  payments: VoicePayment[];
  dueDate: string;
  comment: string;
  transcript: string;
  totalMinor: bigint;
  balanceMinor: bigint;
  /** How the quick sale should show the payment: one way, split, or owed. Worked out here so the quick sale stays small. */
  mode: "cash" | "transfer" | "pos" | "credit" | "split";
  split: { cash: string; transfer: string; pos: string };
};

type Props = {
  products: CachedProduct[];
  currency: string;
  owner: OutboxOwner | null;
  canChangePrice: boolean;
  canGiveCredit: boolean;
  /** The shop sells items not in its products (ADR-041): a new item said is sold as typed and remembered. */
  typedItems?: boolean;
  /** At a sales desk the cashier takes the money; the payment said is only what the customer asked for. */
  desk?: boolean;
  /** Fill the sale with what was said; `save` also records it straight away. */
  onDone: (result: VoiceResult, save: boolean) => void;
  onClose: () => void;
};

type Stage = "start" | "recording" | "reading" | "typing" | "review";
type PaymentRow = { method: VoicePayment["method"]; amount: string };

const METHODS: VoicePayment["method"][] = ["cash", "transfer", "pos"];

/**
 * Record a sale by voice (ADR-040). The words are turned into text on this phone, read into a sale with fixed rules,
 * checked against this shop's products, prices and customers, and shown for correcting. Nothing is saved until the
 * person confirms, and then the normal sale is used, online or offline. Loaded only when opened.
 */
/** Units offered for typed items (ADR-041). */
const TYPED_UNITS = ["piece", "pack", "carton", "bag", "sachet", "bottle", "tin", "crate", "dozen", "paint", "kg", "litre"];

export default function VoiceSale({ products, currency, owner, canChangePrice, canGiveCredit, typedItems = false, desk = false, onDone, onClose }: Props) {
  const t = useTranslations("sales.voice");
  const locale = useLocale();
  const unitName = useUnitName();
  const money = useCallback((minor: bigint) => formatCurrency(minor, currency, locale), [currency, locale]);
  const [online, setOnline] = useState(true);
  const [support, setSupport] = useState<Support | null>(null);
  const [state, setState] = useState<InstallState | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const [progress, setProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [stage, setStage] = useState<Stage>("start");
  const [problem, setProblem] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [typed, setTyped] = useState("");
  const [transcript, setTranscript] = useState("");
  const [review, setReview] = useState<SaleReview | null>(null);
  // Goes up each time the words are read again, so typed boxes start fresh from the new reading.
  const [reading, setReading] = useState(0);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [dueDate, setDueDate] = useState("");
  const [comment, setComment] = useState("");
  const [customers, setCustomers] = useState<DirectoryCustomer[]>([]);
  const [customerSearch, setCustomerSearch] = useState("");
  const recording = useRef<Recording | null>(null);
  const ticker = useRef<number | null>(null);
  const options = useMemo(() => ({ canChangePrice, canGiveCredit, typedItems }), [canChangePrice, canGiveCredit, typedItems]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  useEffect(() => {
    void (async () => {
      const found = await detectSupport();
      setSupport(found);
      setState(await installState());
      setSize(await downloadSize(found.webgpu));
    })();
  }, []);

  // Customer names for matching, saved on the phone and refreshed when there is a network.
  useEffect(() => {
    if (!owner) return;
    void (async () => {
      const saved = await readCustomerDirectory(owner).catch(() => null);
      if (saved) setCustomers(saved.items);
      const fresh = await refreshCustomerDirectory(owner);
      if (fresh) setCustomers(fresh.items);
    })();
  }, [owner]);

  useEffect(
    () => () => {
      recording.current?.cancel();
      if (ticker.current) window.clearInterval(ticker.current);
    },
    [],
  );

  const reviewCustomers: ReviewCustomer[] = useMemo(() => customers.map((customer) => ({ id: customer.id, name: customer.name, creditAllowed: customer.creditAllowed })), [customers]);

  function read(text: string) {
    const words = text.trim();
    setTranscript(words);
    if (!words) {
      setProblem(t("nothingHeard"));
      setStage("start");
      return;
    }
    const sale = parseSpokenSale(words, { currency });
    const built = buildReview(sale, products, reviewCustomers, options);
    setReview(built);
    setReading((count) => count + 1);
    const said = sale.payments.filter((payment) => payment.amountMinor !== null);
    setPayments(
      said.length > 0
        ? said.map((payment) => ({ method: payment.method, amount: amountText(payment.amountMinor!, currency) }))
        : [{ method: sale.payments[0]?.method ?? "cash", amount: built.paidMinor !== null ? amountText(built.paidMinor, currency) : "" }],
    );
    setDueDate("");
    setComment("");
    setProblem(null);
    setStage("review");
    track("voice.review_shown");
  }

  function close() {
    if (stage === "review") track("voice.review_closed");
    onClose();
  }

  /** Words heard by Bizora AI on the server, read here the same way as words heard on the phone. */
  function fromServer(result: CaptureResult) {
    read(result.transcript ?? "");
  }

  async function download() {
    setProblem(null);
    setProgress({ loaded: 0, total: size ?? 0 });
    try {
      track("voice.download_started");
      setState(await install((loaded, total) => setProgress({ loaded, total })));
      track("voice.download_finished");
    } catch (error) {
      track("voice.download_failed", error instanceof VoiceError ? error.code : navigator.onLine ? "failed" : "offline");
      setProblem(installProblem(error));
    } finally {
      setProgress(null);
    }
  }

  function installProblem(error: unknown) {
    if (error instanceof VoiceError) {
      if (error.code === "no_room") return t("errors.noRoom", { size: megabytes(Number(error.message)) });
      if (error.code === "not_published") return t("errors.notPublished");
      if (error.code === "unsupported") return t("errors.unsupported");
    }
    return navigator.onLine ? t("errors.downloadFailed") : t("errors.offlineDownload");
  }

  async function startListening() {
    setProblem(null);
    try {
      // Loading from the phone's own copy needs no network; it starts while the person speaks.
      void prepare().catch(() => undefined);
      recording.current = await startRecording(() => void stopListening());
      setSeconds(0);
      setStage("recording");
      const began = Date.now();
      ticker.current = window.setInterval(() => {
        setSeconds(Math.floor((Date.now() - began) / 1000));
        setLevel(recording.current?.level() ?? 0);
      }, 150);
    } catch {
      setProblem(t("errors.microphone"));
      setStage("start");
    }
  }

  async function stopListening() {
    if (ticker.current) window.clearInterval(ticker.current);
    ticker.current = null;
    const current = recording.current;
    recording.current = null;
    if (!current) return;
    setStage("reading");
    try {
      const recorded = await current.stop();
      // Trim silence, remove hum, level quiet speech (ADR-041). Nothing said: say so instead of guessing.
      const cleaned = cleanUp(recorded);
      if (!cleaned.heard) {
        track("voice.read_failed", "nothing_heard");
        setProblem(t("errors.nothingHeard"));
        setStage("start");
        return;
      }
      await prepare();
      // This shop's own names go first, so the model expects them (ADR-041).
      const prompt = speechPrompt({ currency, products: products.map((product) => product.name), customers: customers.map((customer) => customer.name) });
      const words = tidyWords(await engine.transcribe(cleaned.audio, prompt));
      if (!words) {
        setProblem(t("errors.nothingHeard"));
        setStage("start");
        return;
      }
      read(words);
    } catch {
      track("voice.read_failed", "transcribe");
      setProblem(t("errors.transcribe"));
      setStage("start");
    }
  }

  function cancelListening() {
    if (ticker.current) window.clearInterval(ticker.current);
    recording.current?.cancel();
    recording.current = null;
    setStage("start");
  }

  // Editing the review: every change goes back through the same checks.
  function recheck(next: SaleReview, rows: PaymentRow[] = payments) {
    const paid = rows.reduce((sum, row) => sum + (parseAmount(row.amount || "0", currency) ?? 0n), 0n);
    setReview(checkReview({ ...next, paidMinor: rows.some((row) => row.amount.trim()) ? paid : null }, options));
  }

  function changeLine(index: number, change: Partial<ReviewLine>) {
    if (!review) return;
    const lines = review.lines.map((line, at) => (at === index ? priceLine({ ...line, ...change }) : line));
    recheck({ ...review, lines });
  }

  function removeLine(index: number) {
    if (!review) return;
    recheck({ ...review, lines: review.lines.filter((_, at) => at !== index) });
  }

  function changePayments(rows: PaymentRow[]) {
    if (!review) return;
    setPayments(rows);
    // Once the person sets what was paid, what was said about it no longer counts.
    recheck({ ...review, sale: { ...review.sale, payments: rows.map((row) => ({ method: row.method, amountMinor: parseAmount(row.amount || "0", currency), methodSaid: true })), balanceMinor: null, paidInFull: false, onCredit: false } }, rows);
  }

  function chooseCustomer(customer: ReviewCustomer | null) {
    if (!review) return;
    setCustomerSearch("");
    recheck({ ...review, customer, customerStatus: customer ? "sure" : "not_said", sale: customer ? review.sale : { ...review.sale, customerText: null } });
  }

  const blockers = review ? blocking(review) : [];
  const owing = review?.balanceMinor !== null && review?.balanceMinor !== undefined && review.balanceMinor > 0n;
  const creditFields = owing ? Boolean(dueDate) && Boolean(comment.trim()) : true;
  const canConfirm = Boolean(review) && blockers.length === 0 && creditFields && review!.totalMinor !== null;

  function finishWith(save: boolean) {
    if (!review) return;
    const lines = review.lines
      .filter((line): line is ReviewLine & { product: NonNullable<ReviewLine["product"]> } => Boolean(line.product))
      .map((line) => {
        // A new item said (ADR-041) is not in the list yet: it goes on the sale as a typed item and is remembered.
        const product = products.find((item) => item.id === line.product.id) ?? { ...line.product, category: null, lowStockLevel: null, barcode: null, trackStock: false, archived: false, typed: true };
        const quantity = line.quantity !== null ? quantityToString(line.quantity) : "1";
        // A price other than the list price goes on the line only for someone allowed to change prices; a typed
        // item always carries the price it sold for.
        const price = (canChangePrice || product.typed) && line.priceMinor !== null && (product.typed || line.priceMinor !== line.listPriceMinor) ? amountText(line.priceMinor, currency) : "";
        return { product, unit: line.unit ?? product.baseUnit, quantity, price };
      });
    const paid = payments
      .map((row) => ({ method: row.method, amountMinor: parseAmount(row.amount || "0", currency) ?? 0n }))
      .filter((row) => row.amountMinor > 0n);
    const paidTotal = paid.reduce((sum, part) => sum + part.amountMinor, 0n);
    const by = (method: string) => paid.filter((part) => part.method === method).reduce((sum, part) => sum + part.amountMinor, 0n);
    const totalMinor = review.totalMinor ?? 0n;
    const balanceMinor = review.balanceMinor ?? 0n;
    let mode: VoiceResult["mode"] = "split";
    if (desk) mode = (paid[0]?.method as VoiceResult["mode"] | undefined) ?? (balanceMinor > 0n ? "credit" : "cash");
    else if (paid.length === 0) mode = "credit";
    else if (paid.length === 1 && paidTotal === totalMinor) mode = paid[0]!.method as VoiceResult["mode"];
    const text = (method: string) => (by(method) ? amountText(by(method), currency) : "");
    track("voice.sale_confirmed");
    onDone(
      {
        lines,
        customer: review.customer ? { id: review.customer.id, name: review.customer.name, credit: { allowed: review.customer.creditAllowed, limitMinor: null } } : null,
        payments: paid,
        dueDate,
        comment: comment.trim(),
        transcript,
        totalMinor,
        balanceMinor,
        mode,
        split: mode === "split" ? { cash: text("cash"), transfer: text("transfer"), pos: text("pos") } : { cash: "", transfer: "", pos: "" },
      },
      save,
    );
  }

  const ready = state?.status === "installed";
  const status = ready ? t("model.ready") : progress ? t("model.downloading", { percent: percent(progress) }) : state?.status === "evicted" ? t("model.evicted") : t("model.missing");

  return (
    <Card className="space-y-4" data-testid="voice-sale">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">{t("title")}</h2>
          <div className="mt-1 flex flex-wrap gap-2 text-xs" aria-live="polite">
            <span className={`rounded-full px-2 py-0.5 ${online ? "bg-success-bg text-success" : "bg-warning-bg text-warning"}`} data-testid="voice-network">
              {online ? t("online") : t("offline")}
            </span>
            <span className="rounded-full bg-sidebar px-2 py-0.5" data-testid="voice-model-status">
              {status}
            </span>
          </div>
        </div>
        <button type="button" className="min-h-11 px-2 text-sm text-muted underline underline-offset-2" onClick={close}>
          {t("close")}
        </button>
      </div>

      {problem ? (
        <p className="rounded-control bg-danger-bg px-3 py-2 text-sm text-danger" role="alert">
          {problem}
        </p>
      ) : null}

      {stage === "start" ? (
        <div className="space-y-4">
          {ready ? (
            <div className="flex flex-col items-center gap-3 py-2">
              <button
                type="button"
                onClick={() => void startListening()}
                className="flex h-24 w-24 items-center justify-center rounded-full bg-primary text-primary-fg shadow focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2"
                aria-label={t("speak")}
                data-testid="voice-start"
              >
                <Mic size={40} aria-hidden="true" />
              </button>
              <p className="text-base font-medium">{t("speak")}</p>
              <p className="max-w-sm text-center text-sm text-muted">{t("example")}</p>
            </div>
          ) : support && !support.ok ? (
            <p className="text-sm" data-testid="voice-unsupported">
              {t("unsupported")}
            </p>
          ) : online ? (
            <div className="space-y-3 rounded-control border border-border p-3">
              <p className="text-sm font-medium">{state?.status === "evicted" ? t("setup.evicted") : t("setup.title")}</p>
              <p className="text-sm text-muted">{t("setup.lead", { size: megabytes(size ?? 0) })}</p>
              {progress ? (
                <div className="space-y-1" data-testid="voice-download-progress">
                  <div className="h-2 overflow-hidden rounded-full bg-sidebar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent(progress)}>
                    <div className="h-full bg-primary transition-[width]" style={{ width: `${percent(progress)}%` }} />
                  </div>
                  <p className="text-xs text-muted">{t("setup.progress", { done: megabytes(progress.loaded), total: megabytes(progress.total || size || 0) })}</p>
                </div>
              ) : (
                <Button onClick={() => void download()} data-testid="voice-download">
                  {t("setup.download")}
                </Button>
              )}
            </div>
          ) : (
            <p className="text-sm" data-testid="voice-needs-network">
              {state?.status === "evicted" ? t("setup.evictedOffline") : t("setup.offline")}
            </p>
          )}
          {!ready && online ? (
            <div className="space-y-1">
              <p className="text-xs text-muted">{t("serverChoice")}</p>
              <CaptureBar target="cart" onRows={fromServer} compact />
            </div>
          ) : null}
          <button type="button" className="min-h-11 text-sm font-medium text-primary underline underline-offset-2" onClick={() => setStage("typing")} data-testid="voice-type-instead">
            {t("typeInstead")}
          </button>
        </div>
      ) : null}

      {stage === "recording" ? (
        <div className="flex flex-col items-center gap-3 py-2" data-testid="voice-recording">
          <p className="flex items-center gap-2 text-base font-medium">
            <span className="inline-block h-3 w-3 animate-pulse rounded-full bg-danger" aria-hidden="true" />
            {t("recording", { time: clock(seconds), max: clock(MAX_SECONDS) })}
          </p>
          <div className="h-2 w-48 overflow-hidden rounded-full bg-sidebar" aria-hidden="true">
            <div className="h-full bg-danger transition-[width] duration-150" style={{ width: `${Math.round(level * 100)}%` }} />
          </div>
          <button type="button" onClick={() => void stopListening()} className="flex h-20 w-20 items-center justify-center rounded-full bg-danger text-white" aria-label={t("stop")} data-testid="voice-stop">
            <span className="h-7 w-7 rounded-sm bg-white" />
          </button>
          <p className="text-sm">{t("stop")}</p>
          <button type="button" className="min-h-11 text-sm text-muted underline underline-offset-2" onClick={cancelListening}>
            {t("cancel")}
          </button>
        </div>
      ) : null}

      {stage === "reading" ? (
        <p className="py-6 text-center text-sm" role="status" data-testid="voice-reading">
          {t("reading")}
        </p>
      ) : null}

      {stage === "typing" ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            track("voice.typed_used");
            read(typed);
          }}
        >
          <FormField id="voice-typed" label={t("typeLabel")} hint={t("example")}>
            <Textarea id="voice-typed" value={typed} rows={3} maxLength={600} onChange={(event) => setTyped(event.target.value)} />
          </FormField>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={!typed.trim()}>
              {t("readIt")}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setStage("start")}>
              {t("back")}
            </Button>
          </div>
        </form>
      ) : null}

      {stage === "review" && review ? (
        <div className="space-y-4" data-testid="voice-review">
          <FormField id="voice-heard" label={t("heardLabel")} hint={t("heardHint")}>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Textarea id="voice-heard" value={transcript} rows={2} maxLength={600} onChange={(event) => setTranscript(event.target.value)} data-testid="voice-transcript" />
              <Button type="button" variant="secondary" onClick={() => read(transcript)}>
                {t("readAgain")}
              </Button>
            </div>
          </FormField>

          <ul className="space-y-3">
            {review.lines.map((line, index) => {
              const product = line.product;
              // Typed items sell in any unit (ADR-041).
              const units = product?.typed ? [...new Set([line.unit ?? product.baseUnit, ...TYPED_UNITS])] : product ? sellingUnitsOf(product) : [];
              const differs = line.listPriceMinor !== null && line.priceMinor !== null && line.priceMinor !== line.listPriceMinor;
              return (
                <li key={`${reading}-${index}`} className="space-y-2 rounded-control border border-border p-3" data-testid="voice-line">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-xs text-muted">
                      {t("youSaid", { words: [line.spoken.quantity !== null ? quantityToString(line.spoken.quantity) : null, line.spoken.unitText, line.spoken.productText].filter(Boolean).join(" ") })}
                    </p>
                    <button type="button" className="min-h-8 text-xs text-danger underline" onClick={() => removeLine(index)}>
                      {t("remove")}
                    </button>
                  </div>
                  <FormField id={`voice-product-${index}`} label={t("product")}>
                    <Select
                      id={`voice-product-${index}`}
                      value={product?.id ?? ""}
                      onChange={(event) =>
                        changeLine(index, { product: products.find((item) => item.id === event.target.value) ?? (product?.isNew && event.target.value === product.id ? product : null), unit: null })
                      }
                    >
                      {product?.isNew ? <option value={product.id}>{t("newItem", { name: product.name })}</option> : null}
                      <option value="">{line.productStatus === "choose" ? t("chooseProduct") : t("pickProduct")}</option>
                      {line.options.length > 0 ? (
                        <optgroup label={t("closest")}>
                          {line.options.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.name}
                            </option>
                          ))}
                        </optgroup>
                      ) : null}
                      <optgroup label={t("allProducts")}>
                        {[...products]
                          .sort((a, b) => a.name.localeCompare(b.name))
                          .map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.name}
                            </option>
                          ))}
                      </optgroup>
                    </Select>
                  </FormField>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <FormField id={`voice-quantity-${index}`} label={t("quantity")}>
                      <Input
                        id={`voice-quantity-${index}`}
                        inputMode="decimal"
                        defaultValue={line.quantity !== null ? quantityToString(line.quantity) : ""}
                        onBlur={(event) => changeLine(index, { quantity: parseQuantity(event.target.value) })}
                      />
                    </FormField>
                    <FormField id={`voice-unit-${index}`} label={t("unit")}>
                      <Select id={`voice-unit-${index}`} value={line.unit ?? ""} disabled={!product} onChange={(event) => changeLine(index, { unit: event.target.value })}>
                        {units.map((unit) => (
                          <option key={unit} value={unit}>
                            {unitName(unit, 1)}
                          </option>
                        ))}
                      </Select>
                    </FormField>
                    <FormField id={`voice-price-${index}`} label={t("price")}>
                      <Input
                        id={`voice-price-${index}`}
                        key={`${reading}-${index}-${line.priceMinor ?? "none"}`}
                        inputMode="decimal"
                        defaultValue={line.priceMinor !== null ? amountText(line.priceMinor, currency) : ""}
                        readOnly={!canChangePrice && !product?.typed}
                        onBlur={(event) => (canChangePrice || product?.typed) && changeLine(index, { priceOverride: parseAmount(event.target.value, currency) })}
                      />
                    </FormField>
                    <div className="flex flex-col justify-end text-sm">
                      <span className="text-xs text-muted">{t("lineTotal")}</span>
                      <span className="font-medium tabular-nums" data-testid="voice-line-total">
                        {line.totalMinor !== null ? money(line.totalMinor) : "—"}
                      </span>
                    </div>
                  </div>
                  <p className="text-xs text-muted">
                    {line.priceSource === "said" ? t("priceSaid") : line.priceSource === "list" ? t("priceList") : line.priceSource === "typed" ? t("priceTyped") : t("priceNone")}
                    {differs ? ` ${t("listPrice", { price: money(line.listPriceMinor!) })}` : ""}
                  </p>
                  {differs ? (
                    <Button type="button" size="sm" variant="secondary" onClick={() => changeLine(index, { priceOverride: line.listPriceMinor })}>
                      {t("useListPrice", { price: money(line.listPriceMinor!) })}
                    </Button>
                  ) : null}
                  {line.spoken.unclearAmountMinor !== null && line.priceMinor === null && line.quantity !== null && line.quantity > 0n ? (
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" size="sm" variant="secondary" onClick={() => changeLine(index, { priceOverride: line.spoken.unclearAmountMinor })}>
                        {t("amountEach", { amount: money(line.spoken.unclearAmountMinor) })}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => changeLine(index, { priceOverride: (line.spoken.unclearAmountMinor! * 1000n + line.quantity! / 2n) / line.quantity! })}
                      >
                        {t("amountAll", { amount: money(line.spoken.unclearAmountMinor), quantity: quantityToString(line.quantity) })}
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>

          <div className="space-y-2 rounded-control border border-border p-3">
            <p className="text-sm font-medium">{t("customer")}</p>
            {review.sale.customerText ? <p className="text-xs text-muted">{t("customerSaid", { name: review.sale.customerText })}</p> : null}
            <Select aria-label={t("customer")} value={review.customer?.id ?? ""} onChange={(event) => chooseCustomer(reviewCustomers.find((item) => item.id === event.target.value) ?? null)} data-testid="voice-customer">
              <option value="">{t("noCustomer")}</option>
              {[...(review.customer && !review.customerOptions.some((item) => item.id === review.customer!.id) ? [review.customer] : []), ...review.customerOptions].map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </Select>
            <Input aria-label={t("findCustomer")} placeholder={t("findCustomer")} value={customerSearch} onChange={(event) => setCustomerSearch(event.target.value)} />
            {customerSearch.trim() ? (
              <ul className="divide-y divide-border rounded-control border border-border text-sm">
                {rank(customerSearch, reviewCustomers, (item) => [item.name], { people: true, limit: 6 }).map(({ item }) => (
                  <li key={item.id}>
                    <button type="button" className="min-h-11 w-full px-3 text-left" onClick={() => chooseCustomer(item)}>
                      {item.name}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {customers.length === 0 ? <p className="text-xs text-muted">{t("noCustomerList")}</p> : null}
          </div>

          <div className="space-y-2 rounded-control border border-border p-3">
            <div className="flex justify-between text-sm">
              <span>{t("total")}</span>
              <span className="font-semibold tabular-nums" data-testid="voice-total">
                {review.totalMinor !== null ? money(review.totalMinor) : "—"}
              </span>
            </div>
            {payments.map((row, index) => (
              <div key={`${reading}-${index}`} className="grid grid-cols-[1fr_8rem] gap-2">
                <FormField id={`voice-paid-${index}`} label={index === 0 ? t("paid") : t("paidAlso")}>
                  <Input
                    id={`voice-paid-${index}`}
                    inputMode="decimal"
                    value={row.amount}
                    onChange={(event) => changePayments(payments.map((item, at) => (at === index ? { ...item, amount: event.target.value } : item)))}
                  />
                </FormField>
                <FormField id={`voice-method-${index}`} label={t("method")}>
                  <Select
                    id={`voice-method-${index}`}
                    value={row.method}
                    onChange={(event) => changePayments(payments.map((item, at) => (at === index ? { ...item, method: event.target.value as PaymentRow["method"] } : item)))}
                  >
                    {METHODS.map((method) => (
                      <option key={method} value={method}>
                        {t(`methods.${method}`)}
                      </option>
                    ))}
                  </Select>
                </FormField>
              </div>
            ))}
            <button type="button" className="min-h-8 text-xs text-primary underline" onClick={() => changePayments([...payments, { method: "transfer", amount: "" }])}>
              {t("addPayment")}
            </button>
            <div className="flex justify-between text-sm">
              <span>{t("balance")}</span>
              <span className={`font-semibold tabular-nums ${owing ? "text-warning" : ""}`} data-testid="voice-balance">
                {review.balanceMinor !== null ? money(review.balanceMinor) : "—"}
              </span>
            </div>
            {owing ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <FormField id="voice-due" label={t("dueDate")}>
                  <Input id="voice-due" type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
                </FormField>
                <FormField id="voice-comment" label={t("creditNote")}>
                  <Input id="voice-comment" value={comment} maxLength={500} placeholder={t("creditNotePlaceholder")} onChange={(event) => setComment(event.target.value)} />
                </FormField>
              </div>
            ) : null}
          </div>

          {review.warnings.length > 0 ? (
            <ul className="space-y-1 text-sm" data-testid="voice-warnings">
              {review.warnings.map((warning, index) => (
                <li key={`${warning.code}-${index}`} className={blockers.includes(warning) ? "text-danger" : "text-warning"}>
                  {warningText(warning, review, t, money, typedItems)}
                </li>
              ))}
            </ul>
          ) : null}
          {owing && !creditFields ? <p className="text-sm text-danger">{t("creditFieldsNeeded")}</p> : null}

          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => finishWith(true)} disabled={!canConfirm} data-testid="voice-confirm">
              {t("confirm")}
            </Button>
            <Button type="button" variant="secondary" onClick={() => finishWith(false)} disabled={review.lines.every((line) => !line.product)}>
              {t("edit")}
            </Button>
            <Button type="button" variant="ghost" onClick={() => (ready ? void startListening() : setStage("typing"))}>
              {ready ? t("recordAgain") : t("typeAgain")}
            </Button>
            <Button type="button" variant="ghost" onClick={close}>
              {t("cancel")}
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function percent(progress: { loaded: number; total: number }) {
  return progress.total > 0 ? Math.min(100, Math.round((progress.loaded / progress.total) * 100)) : 0;
}

function megabytes(bytes: number) {
  return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
}

function clock(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function warningText(warning: ReviewWarning, review: SaleReview, t: ReturnType<typeof useTranslations<"sales.voice">>, money: (minor: bigint) => string, typedItems = false) {
  const said = (line: number) => review.lines[line]?.spoken.productText ?? "";
  switch (warning.code) {
    case "product_unknown":
      return t(typedItems ? "warnings.product_unknown" : "warnings.product_unknown_list", { name: warning.said });
    case "new_item":
      return t("warnings.new_item", { name: warning.name });
    case "product_choose":
      return t("warnings.product_choose", { name: warning.said });
    case "unit_not_sold":
      return t("warnings.unit_not_sold", { unit: warning.unit, name: said(warning.line) });
    case "no_quantity":
      return t("warnings.no_quantity", { name: said(warning.line) });
    case "no_price":
      return t("warnings.no_price", { name: said(warning.line) });
    case "price_unclear":
      return t("warnings.price_unclear", { amount: money(warning.amountMinor), name: said(warning.line) });
    case "price_differs":
      return t("warnings.price_differs", { said: money(warning.saidMinor), list: money(warning.listMinor), name: said(warning.line) });
    case "price_needs_manager":
      return t("warnings.price_needs_manager", { said: money(warning.saidMinor), list: money(warning.listMinor), name: said(warning.line) });
    case "customer_unknown":
      return t("warnings.customer_unknown", { name: warning.said });
    case "customer_choose":
      return t("warnings.customer_choose", { name: warning.said });
    case "customer_no_credit":
      return t("warnings.customer_no_credit", { name: warning.name });
    case "said_total_differs":
      return t("warnings.said_total_differs", { said: money(warning.saidMinor), total: money(warning.workedOutMinor) });
    case "paid_more_than_total":
      return t("warnings.paid_more_than_total", { paid: money(warning.paidMinor), total: money(warning.totalMinor) });
    case "currency_mismatch":
      return t("warnings.currency_mismatch", { said: warning.said, expected: warning.expected });
    default:
      return t(`warnings.${warning.code}`);
  }
}
