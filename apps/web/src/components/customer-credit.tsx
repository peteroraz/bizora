"use client";

import { Permission, parseMoneyInput } from "@bizora/contracts";
import { Card, FormField, Input, SafeForm, SubmitButton } from "@bizora/ui";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { formatCurrency } from "../i18n/format";
import { can } from "../lib/access";
import { useAccess } from "../lib/access-context";
import { api } from "../lib/api";

export type CustomerCreditView = { allowed: boolean; limitMinor: string | null };

/** Kobo as typed naira for the limit field. */
export function nairaText(minor: string | null) {
  if (!minor) return "";
  const value = BigInt(minor);
  return value % 100n === 0n ? (value / 100n).toString() : `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
}

/**
 * Whether a customer may buy on credit, their limit and what they owe now. Managers and owners (debtors.manage)
 * approve customers and set limits; cashiers then give credit within the limit (ADR-016).
 */
export function CustomerCredit({ customerId, credit, owingMinor, currency = "NGN", onSaved }: { customerId: string; credit: CustomerCreditView; owingMinor: string; currency?: string; onSaved: () => void }) {
  const t = useTranslations("customers");
  const locale = useLocale();
  const access = useAccess();
  const canApprove = can(access, Permission.DEBTORS_MANAGE);
  const [allowed, setAllowed] = useState(credit.allowed);
  const [limit, setLimit] = useState(nairaText(credit.limitMinor));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const money = (minor: string) => formatCurrency(BigInt(minor), currency, locale);

  async function save() {
    setError(null);
    setSaved(false);
    const limitMinor = limit.trim() ? parseMoneyInput(limit) : null;
    if (limit.trim() && limitMinor === null) {
      setError(t("creditLimitInvalid"));
      return;
    }
    setPending(true);
    const response = await api(`/api/v1/customers/${customerId}/credit`, {
      method: "PATCH",
      body: JSON.stringify({ creditAllowed: allowed, creditLimitMinor: limitMinor === null ? null : limitMinor.toString() }),
    }).catch(() => null);
    setPending(false);
    if (response?.ok) {
      setSaved(true);
      onSaved();
      return;
    }
    setError(t("creditSaveFailed"));
  }

  return (
    <Card>
      <p className="text-sm font-medium">{t("creditTitle")}</p>
      <p className="mt-1 text-sm">
        {credit.allowed ? (credit.limitMinor ? t("creditAllowedWithLimit", { limit: money(credit.limitMinor) }) : t("creditAllowedNoLimit")) : t("creditNotAllowed")}
      </p>
      <p className="text-sm text-muted">
        {t("creditOwing", { amount: money(owingMinor) })}
        {BigInt(owingMinor) > 0n && can(access, Permission.DEBTORS_READ) ? (
          <>
            {" "}
            <Link href={`/app/debtors/${customerId}`} className="text-primary">
              {t("seeAccount")}
            </Link>
          </>
        ) : null}
      </p>
      {canApprove ? (
        <SafeForm className="mt-3 space-y-3" pending={pending} onSubmit={() => void save()}>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={allowed} onChange={(event) => setAllowed(event.target.checked)} />
            {t("creditAllowLabel")}
          </label>
          {allowed ? (
            <FormField id={`credit-limit-${customerId}`} label={t("creditLimitLabel")} hint={t("creditLimitHint")}>
              <Input id={`credit-limit-${customerId}`} inputMode="decimal" value={limit} onChange={(event) => setLimit(event.target.value)} />
            </FormField>
          ) : null}
          {error ? (
            <p className="text-sm text-danger" role="alert">
              {error}
            </p>
          ) : null}
          {saved ? (
            <p className="text-sm text-success" role="status">
              {t("creditSaved")}
            </p>
          ) : null}
          <SubmitButton pending={pending} pendingLabel={t("saving")}>
            {t("creditSave")}
          </SubmitButton>
        </SafeForm>
      ) : null}
    </Card>
  );
}
