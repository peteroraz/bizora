"use client";

import { currencyDigits, JOB_LINE_KINDS, JOB_PAID_FROM, type JobLineKind } from "@bizora/contracts";
import { Button, FormField, Input, Select } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { usePlace } from "../lib/access-context";
import { api } from "../lib/api";
import { blankLine, minorToText, type DraftLine, type Regular } from "../lib/jobs-client";
import { listPrice, sellingUnits } from "../lib/sales-client";
import type { ProductView } from "../lib/stock-client";
import { AmountInput, QuantityInput, SentenceInput } from "./typing";

const BOUGHT_UNITS = ["piece", "litre", "kg", "metre", "yard", "set", "pair", "pack", "roll", "bottle", "can", "tin"];

/**
 * The lines of a job (ADR-035), one card each: work done, a part from stock, something bought for the job, or a
 * helper paid. Every line can be changed or taken off before saving, and more can be added by hand.
 */
export function JobLinesEditor({ lines, onChange, regulars }: { lines: DraftLine[]; onChange: (lines: DraftLine[]) => void; regulars: Regular[] }) {
  const t = useTranslations("jobs.lines");
  const update = (key: string, patch: Partial<DraftLine>) => onChange(lines.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  return (
    <div className="space-y-3" data-testid="job-lines">
      {lines.length === 0 ? <p className="text-sm text-muted">{t("none")}</p> : null}
      {lines.map((line, index) => (
        <LineCard key={line.key} line={line} index={index} regulars={regulars} onChange={(patch) => update(line.key, patch)} onRemove={() => onChange(lines.filter((item) => item.key !== line.key))} />
      ))}
      <div className="flex flex-wrap gap-2">
        {JOB_LINE_KINDS.map((kind) => (
          <Button key={kind} type="button" size="sm" variant="secondary" onClick={() => onChange([...lines, blankLine(kind)])}>
            {t(`add.${kind}`)}
          </Button>
        ))}
      </div>
    </div>
  );
}

function LineCard({ line, index, regulars, onChange, onRemove }: { line: DraftLine; index: number; regulars: Regular[]; onChange: (patch: Partial<DraftLine>) => void; onRemove: () => void }) {
  const t = useTranslations("jobs.lines");
  const units = useTranslations("units");
  const { currency } = usePlace();
  const digits = currencyDigits(currency);
  const id = (name: string) => `line-${line.key}-${name}`;
  const label = (name: string) => t("fieldOf", { field: t(`fields.${name}`), line: index + 1 });
  return (
    <div className="space-y-3 rounded-md border border-border p-3" data-testid="job-line">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <FormField id={id("kind")} label={label("kind")}>
          <Select id={id("kind")} value={line.kind} onChange={(event) => onChange({ ...blankLine(event.target.value as JobLineKind), key: line.key, description: line.description })}>
            {JOB_LINE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`kinds.${kind}`)}
              </option>
            ))}
          </Select>
        </FormField>
        <Button type="button" size="sm" variant="ghost" onClick={onRemove}>
          {t("remove", { line: index + 1 })}
        </Button>
      </div>

      {line.kind === "part" ? (
        <PartPicker line={line} label={label("product")} id={id("product")} onChange={onChange} />
      ) : (
        <FormField id={id("description")} label={label(line.kind === "helper" ? "helper" : "description")}>
          <SentenceInput
            id={id("description")}
            value={line.description}
            maxLength={160}
            list={line.kind === "work" ? "job-regulars" : undefined}
            onChange={(event) => {
              const description = event.target.value;
              const regular = line.kind === "work" ? regulars.find((item) => item.name.toLowerCase() === description.trim().toLowerCase()) : undefined;
              onChange(regular ? { description: regular.name, productId: regular.id, price: line.price || minorToText(regular.priceMinor, digits) } : { description, productId: line.kind === "work" ? null : line.productId });
            }}
          />
        </FormField>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        {line.kind === "part" || line.kind === "bought" ? (
          <>
            <FormField id={id("quantity")} label={label("quantity")}>
              <QuantityInput id={id("quantity")} value={line.quantity} onChange={(event) => onChange({ quantity: event.target.value })} />
            </FormField>
            <FormField id={id("unit")} label={label("unit")}>
              <Select id={id("unit")} value={line.unit} onChange={(event) => onChange({ unit: event.target.value })}>
                {(line.kind === "part" || line.productId ? line.units : [...new Set([...line.units, ...BOUGHT_UNITS])]).map((unit) => (
                  <option key={unit} value={unit}>
                    {units(unit, { count: 1 })}
                  </option>
                ))}
              </Select>
            </FormField>
          </>
        ) : null}
        {line.kind === "bought" || line.kind === "helper" ? (
          <FormField id={id("cost")} label={label(line.kind === "helper" ? "paid" : "cost")}>
            <AmountInput currency={currency} id={id("cost")} value={line.cost} onChange={(event) => onChange({ cost: event.target.value })} />
          </FormField>
        ) : null}
        {line.kind !== "helper" ? (
          <FormField id={id("price")} label={label(line.kind === "part" ? "priceEach" : line.kind === "bought" ? "charge" : "price")} hint={line.kind === "bought" ? t("chargeHint") : undefined}>
            <AmountInput currency={currency} id={id("price")} value={line.price} onChange={(event) => onChange({ price: event.target.value })} />
          </FormField>
        ) : null}
        {line.kind === "bought" || line.kind === "helper" ? (
          <FormField id={id("paidFrom")} label={label("paidFrom")}>
            <Select id={id("paidFrom")} value={line.paidFrom} onChange={(event) => onChange({ paidFrom: event.target.value as DraftLine["paidFrom"] })}>
              {JOB_PAID_FROM.map((from) => (
                <option key={from} value={from}>
                  {t(`paidFrom.${from}`)}
                </option>
              ))}
            </Select>
          </FormField>
        ) : null}
        {line.kind === "bought" ? (
          <FormField id={id("supplier")} label={label("supplier")} hint={line.paidFrom === "owed" ? undefined : t("optional")}>
            <SentenceInput id={id("supplier")} value={line.supplier} maxLength={160} onChange={(event) => onChange({ supplier: event.target.value })} />
          </FormField>
        ) : null}
      </div>
      {line.kind === "work" && !line.productId && line.description.trim() ? (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={line.save} onChange={(event) => onChange({ save: event.target.checked })} />
          {t("save")}
        </label>
      ) : null}
      {line.kind === "work" && line.productId ? <p className="text-xs text-muted">{t("regular")}</p> : null}
      {line.kind === "bought" ? <p className="text-xs text-muted">{t("boughtNote")}</p> : null}
    </div>
  );
}

/** Find a product in stock by typing its name. */
function PartPicker({ line, id, label, onChange }: { line: DraftLine; id: string; label: string; onChange: (patch: Partial<DraftLine>) => void }) {
  const t = useTranslations("jobs.lines");
  const { currency } = usePlace();
  const digits = currencyDigits(currency);
  const [query, setQuery] = useState(line.description);
  const [found, setFound] = useState<ProductView[]>([]);
  useEffect(() => {
    if (!query.trim() || query === line.description) {
      setFound([]);
      return;
    }
    const timer = setTimeout(() => {
      void api(`/api/v1/products?q=${encodeURIComponent(query.trim())}`)
        .then(async (response) => (response.ok ? ((await response.json()).data.items as ProductView[]) : []))
        .then((items) => setFound(items.filter((item) => item.trackStock).slice(0, 5)))
        .catch(() => setFound([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [query, line.description]);
  return (
    <div className="space-y-2">
      <FormField id={id} label={label}>
        <Input id={id} type="search" value={query} autoComplete="off" onChange={(event) => setQuery(event.target.value)} placeholder={t("findPart")} />
      </FormField>
      {found.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {found.map((product) => (
            <Button
              key={product.id}
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setQuery(product.name);
                setFound([]);
                onChange({ productId: product.id, description: product.name, units: sellingUnits(product), unit: product.baseUnit, price: minorToText(listPrice(product, product.baseUnit), digits) });
              }}
            >
              {product.name}
            </Button>
          ))}
        </div>
      ) : null}
      {line.productId ? <p className="text-xs text-muted">{t("chosen", { name: line.description })}</p> : null}
    </div>
  );
}

/** The regular jobs, offered as the description is typed. */
export function RegularsList({ regulars }: { regulars: Regular[] }) {
  return (
    <datalist id="job-regulars">
      {regulars.map((regular) => (
        <option key={regular.id} value={regular.name} />
      ))}
    </datalist>
  );
}
