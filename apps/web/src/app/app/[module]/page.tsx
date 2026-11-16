import { Badge, EmptyState } from "@bizora/ui";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { RequireAccess } from "../../../components/require-access";
import { moduleRule } from "../../../lib/access";
import { comingSoonModules } from "../../../lib/nav";

export default async function ComingSoonPage({ params }: { params: Promise<{ module: string }> }) {
  const { module } = await params;
  if (!(module in comingSoonModules)) notFound();
  const t = await getTranslations("comingSoon");
  const key = module as keyof typeof comingSoonModules;
  const copy = {
    debtors: { title: t("debtorsTitle"), body: t("debtorsBody") },
    money: { title: t("moneyTitle"), body: t("moneyBody") },
    reports: { title: t("reportsTitle"), body: t("reportsBody") },
  }[key];
  return (
    <RequireAccess anyOf={[...(moduleRule(key) ?? [])]}>
      <EmptyState title={copy.title} description={copy.body} action={<Badge tone="info">{t("badge")}</Badge>} />
    </RequireAccess>
  );
}
