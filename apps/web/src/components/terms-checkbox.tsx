"use client";

import { useTranslations } from "next-intl";

/**
 * "I agree to the Terms of use", with a link that opens them in a new tab (ADR-039). The box is required, so the
 * form cannot be sent without it.
 */
export function TermsCheckbox({ checked, onChange, id = "accept-terms" }: { checked: boolean; onChange: (checked: boolean) => void; id?: string }) {
  const t = useTranslations("terms");
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="flex items-start gap-3 text-sm">
        <input id={id} name="acceptTerms" type="checkbox" required className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--primary)]" checked={checked} onChange={(event) => onChange(event.target.checked)} />
        <span>
          {t("agreePrefix")}{" "}
          <a href="/terms" target="_blank" rel="noopener" className="font-medium text-primary underline underline-offset-2">
            {t("linkText")}
          </a>
          {t("agreeSuffix")}
        </span>
      </label>
      <p className="pl-8 text-xs text-muted">
        {t("accessNote")}{" "}
        <a href="/terms#bizora-access" target="_blank" rel="noopener" className="text-primary underline underline-offset-2">
          {t("accessLink")}
        </a>
      </p>
    </div>
  );
}
