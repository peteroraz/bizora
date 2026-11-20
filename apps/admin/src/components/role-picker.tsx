"use client";

import { ADMIN_ROLES, type AdminRole } from "@bizora/contracts";
import { useTranslations } from "next-intl";

export function RolePicker({ value, onChange, idPrefix }: { value: AdminRole[]; onChange: (roles: AdminRole[]) => void; idPrefix: string }) {
  const t = useTranslations("staff");
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{t("roles")}</legend>
      {ADMIN_ROLES.map((role) => (
        <label key={role} htmlFor={`${idPrefix}-${role}`} className="flex items-start gap-2 text-sm">
          <input
            id={`${idPrefix}-${role}`}
            type="checkbox"
            className="mt-1 h-4 w-4 accent-[var(--primary)]"
            checked={value.includes(role)}
            onChange={(event) => onChange(event.target.checked ? [...value, role] : value.filter((item) => item !== role))}
          />
          <span>
            <span className="font-medium">{t(`roleNames.${role}`)}</span>
            <span className="block text-muted">{t(`roleHints.${role}`)}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
