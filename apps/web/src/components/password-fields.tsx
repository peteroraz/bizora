"use client";

import { passwordRules } from "@bizora/contracts/password";
import { FormField, Input } from "@bizora/ui";
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
        aria-label={visible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
        onClick={() => setVisible((current) => !current)}
      >
        {visible ? "Hide" : "Show"}
      </button>
    </div>
  );
}

export function PasswordRules({ password }: { password: string }) {
  return (
    <ul className="space-y-1" aria-label="Password rules">
      {passwordRules.map((rule) => {
        const met = rule.met(password);
        return (
          <li key={rule.id} className={met ? "text-xs text-success" : "text-xs text-muted"}>
            <span aria-hidden="true">{met ? "✓ " : "○ "}</span>
            {rule.label}
            <span className="sr-only">{met ? ", met" : ", not met"}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function PasswordWithConfirmation({
  passwordId,
  confirmId,
  passwordLabel = "Password",
  confirmLabel = "Confirm password",
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
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <FormField id={passwordId} label={passwordLabel}>
          <SecretInput
            id={passwordId}
            label={passwordLabel}
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
      <FormField id={confirmId} label={confirmLabel} error={mismatch ?? undefined}>
        <SecretInput
          id={confirmId}
          label={confirmLabel}
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
  return (
    <FormField id={id} label="Current password">
      <SecretInput
        id={id}
        label="Current password"
        value={value}
        onChange={onChange}
        autoComplete="current-password"
      />
    </FormField>
  );
}
