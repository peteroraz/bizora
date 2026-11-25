"use client";

import { HOLD_REASONS, type HoldReason } from "@bizora/contracts";
import { Badge, Button, FormField, Input, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { adminApi } from "@/lib/admin-api";
import { useCan } from "@/lib/admin-context";
import { day, when } from "@/lib/format";
import { ReasonDialog } from "./reason-dialog";
import { Section } from "./section";

type Lifecycle = {
  hold: "none" | "suspended";
  reasonCode: HoldReason | null;
  since: string | null;
  reviewOn: string | null;
  suspendedBy: string | null;
  events: { id: string; from: string; to: string; reasonCode: HoldReason | null; note: string; caseRef: string | null; reviewOn: string | null; by: string | null; at: string }[];
};

/**
 * Suspend or reinstate a business (ADR-071). Both need a fresh sign-in and a reason; fraud and security suspensions
 * are lifted by someone else. The note stays with Bizora staff; the owner sees only the category.
 */
export function LifecyclePanel({ tenantId }: { tenantId: string }) {
  const t = useTranslations("lifecycle");
  const canSuspend = useCan("business.suspend");
  const canReinstate = useCan("business.reinstate");
  const [state, setState] = useState<Lifecycle | null>(null);
  const [reasonCode, setReasonCode] = useState<HoldReason>("terms");
  const [caseRef, setCaseRef] = useState("");

  const load = useCallback(async () => {
    setState((await adminApi<{ lifecycle: Lifecycle }>(`/businesses/${tenantId}/lifecycle`)).lifecycle);
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!state) return null;
  const suspended = state.hold === "suspended";
  return (
    <Section title={t("title")}>
      <div className="flex flex-wrap items-center justify-between gap-3" data-testid="lifecycle-state">
        <div className="space-y-1">
          <Badge tone={suspended ? "danger" : "success"}>{suspended ? t("suspended") : t("active")}</Badge>
          {suspended ? (
            <p className="text-sm text-muted">
              {t("suspendedLine", { reason: t(`reasons.${state.reasonCode ?? "other"}`), since: when(state.since), by: state.suspendedBy ?? "", review: day(state.reviewOn) })}
            </p>
          ) : (
            <p className="text-sm text-muted">{t("activeLine")}</p>
          )}
        </div>
        {!suspended && canSuspend ? (
          <ReasonDialog
            title={t("suspendTitle")}
            description={t("suspendDescription")}
            done={t("suspendDone")}
            danger
            trigger={<Button variant="danger">{t("suspend")}</Button>}
            onConfirm={async (reason) => {
              await adminApi(`/businesses/${tenantId}/suspend`, { method: "POST", body: { reasonCode, reason, ...(caseRef.trim() ? { caseRef: caseRef.trim() } : {}) } });
              setCaseRef("");
              await load();
            }}
          >
            <FormField id="hold-reason-code" label={t("category")} hint={t("categoryHint")}>
              <Select id="hold-reason-code" value={reasonCode} onChange={(event) => setReasonCode(event.target.value as HoldReason)}>
                {HOLD_REASONS.map((code) => (
                  <option key={code} value={code}>
                    {t(`reasons.${code}`)}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField id="hold-case-ref" label={t("caseRef")} hint={t("caseRefHint")}>
              <Input id="hold-case-ref" maxLength={64} value={caseRef} onChange={(event) => setCaseRef(event.target.value)} />
            </FormField>
          </ReasonDialog>
        ) : null}
        {suspended && canReinstate ? (
          <ReasonDialog
            title={t("reinstateTitle")}
            description={t("reinstateDescription")}
            done={t("reinstateDone")}
            trigger={<Button variant="secondary">{t("reinstate")}</Button>}
            onConfirm={async (reason) => {
              await adminApi(`/businesses/${tenantId}/reinstate`, { method: "POST", body: { reason } });
              await load();
            }}
          />
        ) : null}
      </div>
      {state.events.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("columns.when")}</TableHead>
              <TableHead>{t("columns.what")}</TableHead>
              <TableHead>{t("columns.why")}</TableHead>
              <TableHead>{t("columns.who")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.events.map((event) => (
              <TableRow key={event.id} data-testid="lifecycle-event">
                <TableCell className="whitespace-nowrap text-sm">{when(event.at)}</TableCell>
                <TableCell className="text-sm">
                  {event.to === "suspended" ? t("eventSuspended", { reason: t(`reasons.${event.reasonCode ?? "other"}`) }) : t("eventReinstated")}
                  {event.caseRef ? <span className="block text-xs text-muted">{t("caseLine", { ref: event.caseRef })}</span> : null}
                </TableCell>
                <TableCell className="text-sm text-muted">{event.note}</TableCell>
                <TableCell className="text-sm">{event.by}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
    </Section>
  );
}
