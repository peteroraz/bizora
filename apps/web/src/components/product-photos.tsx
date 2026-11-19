"use client";

import { PRODUCT_PHOTO_MAX } from "@bizora/contracts";
import { Card } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { photoToUpload } from "../lib/capture-client";

type Photo = { id: string; position: number; width: number; height: number; url: string };

/**
 * A product's photos (ADR-033): up to 5, the first is the main one shown in lists. Those who manage products add a
 * photo from the camera or the phone's pictures, make one the main photo, or remove one.
 */
export function ProductPhotos({ productId, productName, canManage, onChange }: { productId: string; productName: string; canManage: boolean; onChange?: (mainUrl: string | null) => void }) {
  const t = useTranslations("stock.photos");
  const [photos, setPhotos] = useState<Photo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Photo | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const apply = useCallback(
    (items: Photo[]) => {
      setPhotos(items);
      onChange?.(items[0]?.url ?? null);
    },
    [onChange],
  );

  useEffect(() => {
    void api(`/api/v1/products/${productId}/photos`)
      .then(async (response) => (response.ok ? setPhotos((await response.json()).data.items) : setPhotos([])))
      .catch(() => setPhotos([]));
  }, [productId]);

  async function send(path: string, init: RequestInit) {
    setBusy(true);
    setError(null);
    const response = await api(path, init).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    setBusy(false);
    if (response?.ok) return apply(payload.data.items);
    setError(response ? (payload?.error?.message ?? t("failed")) : t("needsNetwork"));
  }

  async function add(files: FileList | null) {
    const list = [...(files ?? [])].slice(0, PRODUCT_PHOTO_MAX - (photos?.length ?? 0));
    for (const file of list) {
      const photo = await photoToUpload(file);
      if (!photo) {
        setError(t("unreadable"));
        continue;
      }
      await send(`/api/v1/products/${productId}/photos`, { method: "POST", body: JSON.stringify(photo) });
    }
    if (input.current) input.current.value = "";
  }

  if (photos === null) return null;
  if (photos.length === 0 && !canManage) return null;
  const full = photos.length >= PRODUCT_PHOTO_MAX;
  return (
    <Card>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium">{t("title")}</p>
        <p className="text-xs text-muted">{t("count", { count: photos.length, max: PRODUCT_PHOTO_MAX })}</p>
      </div>
      <ul className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-5" aria-label={t("title")} data-testid="product-photos">
        {photos.map((photo, index) => (
          <li key={photo.id} className="relative">
            <button type="button" className="block w-full overflow-hidden rounded-md border border-border" onClick={() => setOpen(photo)} aria-label={t("open", { number: index + 1, name: productName })}>
              <img src={photo.url} alt={t("alt", { number: index + 1, name: productName })} className="aspect-square w-full object-cover" loading="lazy" />
            </button>
            {index === 0 ? <span className="absolute left-1 top-1 rounded bg-card px-1.5 text-xs font-medium">{t("main")}</span> : null}
          </li>
        ))}
        {canManage && !full ? (
          <li>
            <label className="flex aspect-square w-full cursor-pointer flex-col items-center justify-center rounded-md border border-dashed border-border text-center text-sm text-primary">
              <span aria-hidden="true" className="text-2xl leading-none">+</span>
              <span>{busy ? t("adding") : t("add")}</span>
              <input
                ref={input}
                type="file"
                accept="image/*"
                multiple
                className="sr-only"
                disabled={busy}
                data-testid="add-product-photo"
                onChange={(event) => void add(event.target.files)}
              />
            </label>
          </li>
        ) : null}
      </ul>
      {full && canManage ? <p className="mt-2 text-xs text-muted">{t("full", { max: PRODUCT_PHOTO_MAX })}</p> : null}
      {error ? (
        <p className="mt-2 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      {open ? (
        <div className="mt-3 space-y-2" data-testid="product-photo-open">
          <img src={open.url} alt={t("alt", { number: open.position + 1, name: productName })} className="max-h-96 w-full rounded-md object-contain" />
          <div className="flex flex-wrap gap-3 text-sm">
            {canManage && open.position > 0 ? (
              <button type="button" className="min-h-11 font-medium text-primary" disabled={busy} onClick={() => void send(`/api/v1/products/${productId}/photos/${open.id}/main`, { method: "POST" }).then(() => setOpen(null))}>
                {t("makeMain")}
              </button>
            ) : null}
            {canManage ? (
              <button type="button" className="min-h-11 font-medium text-danger" disabled={busy} onClick={() => void send(`/api/v1/products/${productId}/photos/${open.id}`, { method: "DELETE" }).then(() => setOpen(null))}>
                {t("remove")}
              </button>
            ) : null}
            <button type="button" className="min-h-11 text-muted" onClick={() => setOpen(null)}>
              {t("close")}
            </button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
