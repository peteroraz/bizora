"use client";

import { ADMIN_LIMITS, type AdminLimit } from "@bizora/contracts";
import { Button, FormField, Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { adminApi } from "@/lib/admin-api";
import { useCan } from "@/lib/admin-context";
import { ReasonDialog } from "./reason-dialog";
import { Section } from "./section";

type Limits = {
  plan: { code: string; name: string };
  serverDailyReads: number;
  limits: { limit: AdminLimit; plan: number; set: number | null; used: number | null }[];
};

/** A business's limits (ADR-039): the plan's numbers, any set for this business, and how many are in use. */
export function LimitsPanel({ tenantId }: { tenantId: string }) {
  const t = useTranslations("business");
  const reason = useTranslations("reason");
  const canChange = useCan("limits.manage");
  const [limits, setLimits] = useState<Limits | null>(null);
  const [draft, setDraft] = useState<Record<AdminLimit, string>>({ max_branches: "", max_staff: "", max_devices: "", ai_daily_reads: "" });

  const load = useCallback(async () => {
    const data = await adminApi<Limits>(`/businesses/${tenantId}/limits`);
    setLimits(data);
    setDraft(Object.fromEntries(data.limits.map((row) => [row.limit, row.set === null ? "" : String(row.set)])) as Record<AdminLimit, string>);
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!limits) return null;
  return (
    <Section title={t("limits")}>
      <p className="text-sm text-muted">{t("limitsLead")}</p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("limitColumns.what")}</TableHead>
            <TableHead className="text-right">{t("limitColumns.plan")}</TableHead>
            <TableHead className="text-right">{t("limitColumns.set")}</TableHead>
            <TableHead className="text-right">{t("limitColumns.used")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {limits.limits.map((row) => (
            <TableRow key={row.limit} data-testid={`limit-${row.limit}`}>
              <TableCell>{t(`limitNames.${row.limit}`)}</TableCell>
              <TableCell className="text-right tabular-nums">{row.plan}</TableCell>
              <TableCell className="text-right tabular-nums">{row.set ?? t("planDefault")}</TableCell>
              <TableCell className="text-right tabular-nums">{row.used ?? ""}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="text-xs text-muted">{t("serverCap", { count: limits.serverDailyReads })}</p>
      {canChange ? (
        <ReasonDialog
          title={reason("changeLimits.title")}
          description={reason("changeLimits.description")}
          done={reason("changeLimits.done")}
          trigger={<Button variant="secondary">{t("changeLimits")}</Button>}
          onConfirm={async (text) => {
            const body = Object.fromEntries(ADMIN_LIMITS.map((limit) => [limit, draft[limit].trim() === "" ? null : Number(draft[limit])]));
            await adminApi(`/businesses/${tenantId}/limits`, { method: "PUT", body: { ...body, reason: text } });
            await load();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {ADMIN_LIMITS.map((limit) => (
              <FormField key={limit} id={`limit-${limit}-input`} label={t(`limitNames.${limit}`)}>
                <Input
                  id={`limit-${limit}-input`}
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={draft[limit]}
                  placeholder={String(limits.limits.find((row) => row.limit === limit)?.plan ?? "")}
                  onChange={(event) => setDraft({ ...draft, [limit]: event.target.value.replace(/\D/g, "") })}
                />
              </FormField>
            ))}
          </div>
        </ReasonDialog>
      ) : null}
    </Section>
  );
}
