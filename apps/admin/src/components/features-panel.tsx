"use client";

import type { BusinessFeature } from "@bizora/contracts";
import { Badge, Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { adminApi } from "@/lib/admin-api";
import { useCan } from "@/lib/admin-context";
import { ReasonDialog } from "./reason-dialog";
import { Section } from "./section";

type FeatureRow = { feature: BusinessFeature; enabled: boolean; default: boolean; locked: boolean; changedAt: string | null; reason: string | null };

/** Switches for one business (ADR-045). Each change asks why; the owner sees it in their activity log. */
export function FeaturesPanel({ tenantId }: { tenantId: string }) {
  const t = useTranslations("business");
  const reason = useTranslations("reason");
  const canChange = useCan("limits.manage");
  const [rows, setRows] = useState<FeatureRow[] | null>(null);

  const load = useCallback(async () => {
    setRows((await adminApi<{ features: FeatureRow[] }>(`/businesses/${tenantId}/features`)).features);
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!rows) return null;
  return (
    <Section title={t("features")}>
      <p className="text-sm text-muted">{t("featuresLead")}</p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("featureColumns.what")}</TableHead>
            <TableHead>{t("featureColumns.state")}</TableHead>
            <TableHead>{t("featureColumns.why")}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.feature} data-testid={`feature-${row.feature}`}>
              <TableCell>
                <p className="font-medium">{t(`featureNames.${row.feature}`)}</p>
                <p className="text-xs text-muted">{t(`featureHints.${row.feature}`)}</p>
              </TableCell>
              <TableCell>
                {row.locked ? (
                  <Badge tone="neutral">{t("featureLocked")}</Badge>
                ) : (
                  <Badge tone={row.enabled ? "success" : "warning"}>{row.enabled ? t("featureOn") : t("featureOff")}</Badge>
                )}
              </TableCell>
              <TableCell className="text-sm text-muted">{row.reason ?? (row.locked ? "" : t("featureDefault"))}</TableCell>
              <TableCell className="text-right">
                {canChange && !row.locked ? (
                  <ReasonDialog
                    title={row.enabled ? reason("featureOff.title", { name: t(`featureNames.${row.feature}`) }) : reason("featureOn.title", { name: t(`featureNames.${row.feature}`) })}
                    description={row.enabled ? reason("featureOff.description") : reason("featureOn.description")}
                    done={row.enabled ? reason("featureOff.done") : reason("featureOn.done")}
                    danger={row.enabled}
                    trigger={<Button variant="secondary">{row.enabled ? t("switchOff") : t("switchOn")}</Button>}
                    onConfirm={async (text) => {
                      await adminApi(`/businesses/${tenantId}/features`, { method: "PUT", body: { feature: row.feature, enabled: !row.enabled, reason: text } });
                      await load();
                    }}
                  />
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  );
}
