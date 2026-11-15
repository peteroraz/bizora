"use client";

import { passwordRules } from "@bizora/contracts/password";
import { FormField, Input } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";

function SecretInput({
  id,
  label,
  value,
  onChange,
  autoComplete,
  invalid,
  describedBy,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  invalid?: boolean;
  describedBy?: string;
}) {
  const t = useTranslations("password");
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input
        id={id}
        type={visible ? "text" : "password"}
        value={value}
        autoComplete={autoComplete}
        className="pr-20"
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        required
        onChange={(event) => onChange(event.target.value)}
      />
      <button
        type="button"
        className="absolute top-1/2 right-2 -translate-y-1/2 rounded-control px-2 py-1 text-xs font-medium text-muted"
        aria-label={visible ? t("hide", { label }) : t("show", { label })}
        onClick={() => setVisible((current) => !current)}
      >
        {visible ? t("hideWord") : t("showWord")}
      </button>
    </div>
  );
}

export function PasswordRules({ password }: { password: string }) {
  const t = useTranslations("password");
  const labels = { "min-length": t("minLength"), "max-length": t("maxLength") };
  return (
    <ul className="space-y-1" aria-label={t("rulesLabel")}>
      {passwordRules.map((rule) => {
        const met = rule.met(password);
        return (
          <li key={rule.id} className={met ? "text-xs text-success" : "text-xs text-muted"}>
            <span aria-hidden="true">{met ? "✓ " : "○ "}</span>
            {labels[rule.id]}
            <span className="sr-only">{met ? t("met") : t("unmet")}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function PasswordWithConfirmation({
  passwordId,
  confirmId,
  passwordLabel,
  confirmLabel,
  password,
  confirmation,
  onPasswordChange,
  onConfirmationChange,
  autoComplete = "new-password",
  mismatch,
}: {
  passwordId: string;
  confirmId: string;
  passwordLabel?: string;
  confirmLabel?: string;
  password: string;
  confirmation: string;
  onPasswordChange: (value: string) => void;
  onConfirmationChange: (value: string) => void;
  autoComplete?: string;
  mismatch: string | null;
}) {
  const t = useTranslations("password");
  const passwordText = passwordLabel ?? t("password");
  const confirmText = confirmLabel ?? t("confirm");
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <FormField id={passwordId} label={passwordText}>
          <SecretInput
            id={passwordId}
            label={passwordText}
            value={password}
            onChange={onPasswordChange}
            autoComplete={autoComplete}
            describedBy={`${passwordId}-rules`}
          />
        </FormField>
        <div id={`${passwordId}-rules`}>
          <PasswordRules password={password} />
        </div>
      </div>
      <FormField id={confirmId} label={confirmText} error={mismatch ?? undefined}>
        <SecretInput
          id={confirmId}
          label={confirmText}
          value={confirmation}
          onChange={onConfirmationChange}
          autoComplete={autoComplete}
          invalid={Boolean(mismatch)}
          describedBy={mismatch ? `${confirmId}-error` : undefined}
        />
      </FormField>
    </div>
  );
}

export function CurrentPasswordField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useTranslations("password");
  return (
    <FormField id={id} label={t("current")}>
      <SecretInput id={id} label={t("current")} value={value} onChange={onChange} autoComplete="current-password" />
    </FormField>
  );
}
