"use client";

import { EmptyState } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { can } from "../lib/access";
import { useAccess } from "../lib/access-context";

/** Shows a short message instead of a page the person's role cannot use. The API refuses the actions either way. */
export function RequireAccess({
  anyOf,
  children,
}: {
  anyOf: string[];
  children: React.ReactNode;
}) {
  const access = useAccess();
  const t = useTranslations("access");
  if (!can(access, ...anyOf))
    return (
      <EmptyState title={t("noPageTitle")} description={t("noPageBody")} />
    );
  return <>{children}</>;
}
