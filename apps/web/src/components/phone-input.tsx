"use client";

import type { PhoneCheck } from "@bizora/contracts";
import { Input, type InputProps } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

type PhoneRules = typeof import("@bizora/contracts/phone");

let loading: Promise<PhoneRules> | null = null;
/** The country rules are large, so they load only when a phone box shows (not part of any screen's first load). */
export function loadPhoneRules() {
  loading ??= import("@bizora/contracts/phone");
  return loading;
}

/**
 * Checks a typed number for the business's country; null when nothing was typed. With no network before the rules
 * arrived, the number goes as typed: the server checks it (and says what is wrong) when it syncs.
 */
export async function checkTypedPhone(text: string, country: string): Promise<PhoneCheck | null> {
  try {
    return (await loadPhoneRules()).checkPhone(text, country);
  } catch {
    loading = null;
    const typed = text.trim();
    return typed ? { ok: true, e164: typed, country: null, national: typed, international: typed } : null;
  }
}

/**
 * A phone box for a business in `country`. Spaces go in as the number is typed, the way the country writes it.
 * When the box is left the number is checked (right digits and length for the country, or another country when it
 * starts with +), and a problem is said under the box in plain words. `onCheck` hands the result to the form.
 */
export function PhoneInput({
  country,
  onCheck,
  ...props
}: Omit<InputProps, "format" | "finish" | "type"> & { country: string; onCheck?: (result: PhoneCheck | null) => void }) {
  const t = useTranslations("typing");
  const [rules, setRules] = useState<PhoneRules | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [other, setOther] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void loadPhoneRules()
      .then((loaded) => live && setRules(loaded))
      .catch(() => {
        // No network yet: the box still takes digits, and the number is checked when it can be.
        loading = null;
      });
    return () => {
      live = false;
    };
  }, []);

  const example = rules?.phoneExample(country) ?? null;
  const name = (code: string | null) => rules?.countryName(code) ?? code ?? "";

  function check(text: string) {
    if (!rules) return;
    const result = rules.checkPhone(text, country);
    onCheck?.(result);
    if (!result || result.ok) {
      setProblem(null);
      setOther(result?.ok && result.country && result.country !== country ? name(result.country) : null);
      return;
    }
    const where = { country: name(result.country), example: rules.phoneExample(result.country) ?? "" };
    setOther(null);
    setProblem(
      result.problem === "too_short"
        ? t("phoneTooShort", where)
        : result.problem === "too_long"
          ? t("phoneTooLong", where)
          : result.country
            ? t("phoneInvalid", where)
            : t("phoneUnknown"),
    );
  }

  return (
    <>
      <Input
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        placeholder={example ?? undefined}
        format={(text) => (rules ? rules.typePhone(text, country) : text.replace(/[^\d+\s]/g, ""))}
        aria-invalid={problem ? true : props["aria-invalid"]}
        {...props}
        onChange={(event) => {
          if (problem) setProblem(null);
          props.onChange?.(event);
        }}
        onBlur={(event) => {
          check(event.currentTarget.value);
          props.onBlur?.(event);
        }}
      />
      {problem ? (
        <p className="text-xs font-medium text-danger" role="alert" data-testid="phone-problem">
          {problem}
        </p>
      ) : other ? (
        <p className="text-xs font-medium text-muted">{t("phoneOtherCountry", { country: other })}</p>
      ) : null}
    </>
  );
}
