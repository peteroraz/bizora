"use client";

import { FormField } from "@bizora/ui";
import { useLocale, useTranslations } from "next-intl";
import { formatCurrency } from "../i18n/format";
import { AmountInput, SentenceInput } from "./typing";

type Split = { cash: string; transfer: string; pos: string };
type Props =
  | { kind: "change"; currency: string; given: string; onGiven: (value: string) => void; change: bigint | null; split?: Split; onSplit?: (value: Split) => void }
  | { kind: "split"; currency: string; split: Split; onSplit: (value: Split) => void; given?: string; onGiven?: (value: string) => void; change?: bigint | null }
  | { kind: "extras"; currency: string; canDiscount: boolean; discount: string; onDiscount: (value: string) => void; note: string; onNote: (value: string) => void };

/**
 * Parts of the quick sale shown only after a tap: change for cash given, amounts for a split payment, and the
 * discount and note. Loaded when first shown, so the quick sale opens within its script budget (ADR-041).
 */
export default function SaleMoneyExtras(props: Props) {
  const t = useTranslations("sales");
  const locale = useLocale();
  const money = (minor: bigint) => formatCurrency(minor, props.currency, locale);
  if (props.kind === "change") {
    const { change } = props;
    return (
      <div className="flex flex-wrap items-end gap-3">
        <FormField id="sale-given" label={t("cashGiven")} hint={t("optional")}>
          <AmountInput currency={props.currency} id="sale-given" className="max-w-40" value={props.given} onChange={(event) => props.onGiven(event.target.value)} />
        </FormField>
        {change !== null ? (
          <p className={`pb-6 text-base font-semibold tabular-nums ${change < 0n ? "text-danger" : "text-success"}`} data-testid="sale-change" role="status">
            {change < 0n ? t("shortBy", { amount: money(-change) }) : t("change", { amount: money(change) })}
          </p>
        ) : null}
      </div>
    );
  }
  if (props.kind === "split") {
    const { split, onSplit } = props;
    return (
      <div className="grid gap-2 sm:grid-cols-3">
        {(["cash", "transfer", "pos"] as const).map((method) => (
          <FormField key={method} id={`split-${method}`} label={t(`mode.${method}`)}>
            <AmountInput currency={props.currency} id={`split-${method}`} value={split[method]} onChange={(event) => onSplit({ ...split, [method]: event.target.value })} />
          </FormField>
        ))}
      </div>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {props.canDiscount ? (
        <FormField id="sale-discount" label={t("discount")} hint={t("optional")}>
          <AmountInput currency={props.currency} id="sale-discount" value={props.discount} onChange={(event) => props.onDiscount(event.target.value)} />
        </FormField>
      ) : null}
      <FormField id="sale-note" label={t("note")} hint={t("optional")}>
        <SentenceInput id="sale-note" value={props.note} maxLength={240} onChange={(event) => props.onNote(event.target.value)} />
      </FormField>
    </div>
  );
}
