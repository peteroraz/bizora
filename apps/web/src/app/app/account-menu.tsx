"use client";

import type { AuthWorkspace } from "@bizora/contracts";
import { DropdownItem, DropdownLabel, DropdownMenu } from "@bizora/ui/dropdown-menu";
import type { ThemeChoice } from "@bizora/ui";
import { Building2, Lock, LogOut } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

export type AccountMenuProps = {
  trigger: ReactNode;
  displayName: string | undefined;
  email: string | null | undefined;
  roleText: string | null;
  theme: ThemeChoice;
  onTheme: (choice: ThemeChoice) => void;
  staffMode: boolean;
  workspaces: AuthWorkspace[];
  currentOrganizationId: string | undefined;
  onSwitch: (organizationId: string) => void;
  onLogout: () => void;
};

/** The account menu. Loaded the first time it is tapped, so its code is not part of every screen's first load. */
export default function AccountMenu(props: AccountMenuProps) {
  const t = useTranslations("shell");
  const themeLabels = useTranslations("theme");
  return (
    <DropdownMenu label={t("account")} trigger={props.trigger} defaultOpen>
      <DropdownLabel>
        <span className="block text-sm font-medium text-fg">{props.displayName}</span>
        <span className="block">{props.email}</span>
        <span className="mt-1 block">{props.roleText}</span>
      </DropdownLabel>
      {(["light", "dark", "system"] as ThemeChoice[]).map((choice) => (
        <DropdownItem key={choice} onSelect={() => props.onTheme(choice)}>
          {themeLabels(choice)}
          {props.theme === choice ? t("currentSuffix") : ""}
        </DropdownItem>
      ))}
      {!props.staffMode && props.workspaces.length > 1 ? (
        <>
          <DropdownLabel>{t("switchBusiness")}</DropdownLabel>
          {props.workspaces.map((workspace) => {
            const current = workspace.organizationId === props.currentOrganizationId;
            return (
              <DropdownItem
                key={workspace.organizationId}
                onSelect={() => {
                  if (!current) props.onSwitch(workspace.organizationId);
                }}
              >
                <span className="inline-flex items-center gap-2">
                  <Building2 className="h-4 w-4" aria-hidden="true" />
                  {workspace.organizationName}
                  {current ? t("currentSuffix") : ""}
                </span>
              </DropdownItem>
            );
          })}
        </>
      ) : null}
      <DropdownItem onSelect={props.onLogout}>
        <span className="inline-flex items-center gap-2">
          {props.staffMode ? <Lock className="h-4 w-4" aria-hidden="true" /> : <LogOut className="h-4 w-4" aria-hidden="true" />}{" "}
          {props.staffMode ? t("lock") : t("logout")}
        </span>
      </DropdownItem>
    </DropdownMenu>
  );
}
