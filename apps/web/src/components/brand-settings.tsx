"use client";

import { BRAND_DEFAULT_COLOR, BRAND_MIN_CONTRAST, BRAND_TEXT_LIMITS, contrastWithWhite, LOGO_MAX_BYTES, LOGO_UPLOAD_SIDE, type BrandingView } from "@bizora/contracts";
import { Button, Card, FormField, Input, Textarea } from "@bizora/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";

type Texts = { receiptMessage: string; invoiceMessage: string; documentTerms: string };
const TEXT_FIELDS = ["receiptMessage", "invoiceMessage", "documentTerms"] as const;

/** Shrinks a picked picture to LOGO_UPLOAD_SIDE pixels and re-saves it, which also drops photo metadata. */
async function prepareLogo(file: File): Promise<{ contentType: "image/png" | "image/jpeg"; dataBase64: string }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, LOGO_UPLOAD_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(16, Math.round(bitmap.width * scale));
  canvas.height = Math.max(16, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const encode = (type: string, quality?: number) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  let blob = await encode("image/png");
  let contentType: "image/png" | "image/jpeg" = "image/png";
  if (!blob || blob.size > LOGO_MAX_BYTES) {
    // Photos are smaller as JPG; JPG has no see-through parts, so they become white.
    context.globalCompositeOperation = "destination-over";
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    blob = await encode("image/jpeg", 0.85);
    contentType = "image/jpeg";
  }
  if (!blob) throw new Error("encode");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return { contentType, dataBase64: btoa(binary) };
}

/** Settings → Your brand: the company logo, colour and what documents say to customers (ADR-021). */
export function BrandSettings() {
  const t = useTranslations("brand");
  const router = useRouter();
  const [branding, setBranding] = useState<BrandingView | null>(null);
  const [color, setColor] = useState(BRAND_DEFAULT_COLOR);
  const [texts, setTexts] = useState<Texts>({ receiptMessage: "", invoiceMessage: "", documentTerms: "" });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function show(view: BrandingView) {
    setBranding(view);
    setColor(view.primaryColor);
    setTexts({ receiptMessage: view.receiptMessage ?? "", invoiceMessage: view.invoiceMessage ?? "", documentTerms: view.documentTerms ?? "" });
  }

  // Loaded once: refreshing the top bar after a logo change must not overwrite what is being typed.
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void api("/api/v1/organizations/current/branding")
      .then(async (response) => (response.ok ? show((await response.json()).data.branding) : setError(t("loadFailed"))))
      .catch(() => setError(t("loadFailed")));
  }, [t]);

  async function send(path: string, init: RequestInit, done: string) {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const response = await api(path, init);
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error?.fieldErrors?.[0]?.message ?? payload?.error?.message ?? t("saveFailed"));
        return;
      }
      const view: BrandingView = payload.data.branding;
      if (path.endsWith("/logo")) setBranding((current) => (current ? { ...current, logo: view.logo } : view));
      else show(view);
      setNotice(done);
      // The logo in the top bar comes from the page layout.
      router.refresh();
    } catch {
      setError(t("saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function pickLogo(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    let body: Awaited<ReturnType<typeof prepareLogo>>;
    try {
      body = await prepareLogo(file);
    } catch {
      setError(t("logoUnreadable"));
      return;
    }
    await send("/api/v1/organizations/current/logo", { method: "PUT", body: JSON.stringify(body) }, t("logoSaved"));
  }

  const validColor = /^#[0-9A-Fa-f]{6}$/.test(color);
  const readable = validColor && contrastWithWhite(color) >= BRAND_MIN_CONTRAST;
  if (!branding) return <p className="text-sm text-muted">{error ?? t("loading")}</p>;

  return (
    <div className="space-y-4">
      <BusinessLink branding={branding} onSaved={(view) => setBranding(view)} />
      {notice ? (
        <p className="rounded-card border border-success bg-success-bg px-4 py-3 text-sm text-success" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="rounded-card border border-danger bg-danger-bg px-4 py-3 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <Card>
        <p className="text-sm font-medium">{t("logoTitle")}</p>
        <p className="mt-1 text-sm text-muted">{t("logoLead")}</p>
        <div className="mt-3 flex flex-wrap items-center gap-4">
          {branding.logo ? (
            // a private, signed-in picture; next/image cannot fetch it
            <img src={`/api/v1/organizations/current/logo?v=${branding.logo.version}`} alt={t("logoAlt")} className="h-16 max-w-48 rounded border border-border bg-white object-contain p-1" data-testid="brand-logo" />
          ) : (
            <p className="text-sm text-muted">{t("noLogo")}</p>
          )}
          <label className="inline-flex h-10 cursor-pointer items-center rounded-control border border-border px-4 text-sm font-medium hover:bg-sidebar">
            {branding.logo ? t("changeLogo") : t("chooseLogo")}
            <input type="file" accept="image/png,image/jpeg,image/webp,image/*" className="sr-only" onChange={(event) => void pickLogo(event)} disabled={busy} aria-label={t("chooseLogo")} />
          </label>
          {branding.logo ? (
            <Button variant="ghost" disabled={busy} onClick={() => void send("/api/v1/organizations/current/logo", { method: "DELETE" }, t("logoRemoved"))}>
              {t("removeLogo")}
            </Button>
          ) : null}
        </div>
      </Card>
      <Card>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!readable) return;
            void send("/api/v1/organizations/current/branding", { method: "PATCH", body: JSON.stringify({ primaryColor: color, ...texts }) }, t("saved"));
          }}
        >
          <FormField id="brand-color" label={t("color")} hint={t("colorHint")} error={validColor && !readable ? t("colorTooLight") : undefined}>
            <div className="flex items-center gap-3">
              <input type="color" aria-label={t("colorPicker")} value={validColor ? color : BRAND_DEFAULT_COLOR} onChange={(event) => setColor(event.target.value.toUpperCase())} className="h-10 w-14 cursor-pointer rounded border border-border bg-input" />
              <Input id="brand-color" value={color} maxLength={7} onChange={(event) => setColor(event.target.value.trim())} className="max-w-32" />
            </div>
          </FormField>
          {TEXT_FIELDS.map((field) => (
            <FormField key={field} id={`brand-${field}`} label={t(`${field}.label`)} hint={`${t(`${field}.hint`)} ${t("count", { used: texts[field].length, max: BRAND_TEXT_LIMITS[field] })}`}>
              <Textarea
                id={`brand-${field}`}
                value={texts[field]}
                maxLength={BRAND_TEXT_LIMITS[field]}
                placeholder={t(`${field}.placeholder`)}
                onChange={(event) => setTexts((current) => ({ ...current, [field]: event.target.value }))}
                className={field === "documentTerms" ? "min-h-28" : "min-h-20"}
              />
            </FormField>
          ))}
          <p className="text-xs text-muted">{t("bizoraLine")}</p>
          <div className="flex flex-wrap items-center gap-4">
            <Button type="submit" disabled={busy || !readable}>
              {t("save")}
            </Button>
            <a href="/api/v1/organizations/current/branding/sample?type=receipt" target="_blank" rel="noopener" className="text-sm font-medium text-primary">
              {t("sampleReceipt")}
            </a>
            <a href="/api/v1/organizations/current/branding/sample?type=invoice" target="_blank" rel="noopener" className="text-sm font-medium text-primary">
              {t("sampleInvoice")}
            </a>
          </div>
          <p className="text-xs text-muted">{t("sampleHint")}</p>
        </form>
      </Card>
    </div>
  );
}

/** Settings → Your brand → Your business link (ADR-024): the name in every receipt, invoice and statement link. */
function BusinessLink({ branding, onSaved }: { branding: BrandingView; onSaved: (view: BrandingView) => void }) {
  const t = useTranslations("brand");
  const [handle, setHandle] = useState(branding.handle ?? "");
  const [about, setAbout] = useState(branding.about ?? "");
  const [check, setCheck] = useState<{ handle: string; available: boolean; reason: string | null } | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [host, setHost] = useState("");
  const wanted = handle.trim().toLowerCase();
  const changed = wanted !== (branding.handle ?? "");

  useEffect(() => setHost(window.location.host), []);

  // Checks the name a moment after typing stops.
  useEffect(() => {
    if (!changed || wanted.length < 3) {
      setCheck(null);
      return;
    }
    const timer = window.setTimeout(() => {
      void api(`/api/v1/organizations/current/handle-check?handle=${encodeURIComponent(wanted)}`)
        .then(async (response) => (response.ok ? setCheck((await response.json()).data) : undefined))
        .catch(() => undefined);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [wanted, changed]);

  async function save() {
    setPending(true);
    setMessage(null);
    const response = await api("/api/v1/organizations/current/profile", {
      method: "PATCH",
      body: JSON.stringify({ ...(changed ? { handle: wanted } : {}), about: about.trim() || null }),
    }).catch(() => null);
    const payload = await response?.json().catch(() => null);
    setPending(false);
    if (!response?.ok) {
      setMessage({ ok: false, text: payload?.error?.fieldErrors?.[0]?.message ?? payload?.error?.message ?? t("saveFailed") });
      return;
    }
    onSaved(payload.data.branding);
    setCheck(null);
    setMessage({ ok: true, text: t("linkSaved") });
  }

  const blocked = changed && (check === null || !check.available || check.handle !== wanted);
  return (
    <Card data-testid="business-link">
      <p className="text-sm font-medium">{t("linkTitle")}</p>
      <p className="mt-1 text-sm text-muted">{t("linkLead")}</p>
      <div className="mt-3 space-y-3">
        <FormField id="brand-handle" label={t("linkName")} hint={t("linkHint")} error={changed && check && !check.available ? (check.reason ?? undefined) : undefined}>
          <div className="flex items-center gap-1">
            <span className="shrink-0 text-sm text-muted">{host}/</span>
            <Input id="brand-handle" value={handle} maxLength={40} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(event) => setHandle(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} />
          </div>
        </FormField>
        {changed && check?.available && check.handle === wanted ? <p className="text-sm text-success">{t("linkFree")}</p> : null}
        {changed && branding.handle ? <p className="text-xs text-muted">{t("linkOldWork")}</p> : null}
        <FormField id="brand-about" label={t("aboutLabel")} hint={t("aboutHint")}>
          <Textarea id="brand-about" value={about} maxLength={280} placeholder={t("aboutPlaceholder")} onChange={(event) => setAbout(event.target.value)} className="min-h-20" />
        </FormField>
        {message ? (
          <p className={`text-sm ${message.ok ? "text-success" : "text-danger"}`} role={message.ok ? "status" : "alert"}>
            {message.text}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-4">
          <Button type="button" disabled={pending || blocked} onClick={() => void save()}>
            {t("linkSave")}
          </Button>
          {branding.handle ? (
            <a href={`/${branding.handle}`} target="_blank" rel="noopener" className="text-sm font-medium text-primary" data-testid="business-page-link">
              {t("linkView")}
            </a>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
