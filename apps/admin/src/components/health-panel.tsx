"use client";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { adminApi } from "@/lib/admin-api";
import { when } from "@/lib/format";
import { Section } from "./section";

type Health = {
  lastActive: string | null;
  lastSync: string | null;
  openSessions: number;
  shopDevicesSignedIn: number;
  syncRefusals: { code: string | null; total: number; lastAt: string | null }[];
  voiceProblems: { event: string; code: string | null; total: number; lastAt: string | null }[];
};

/** For support (ADR-045): what went wrong for this business in the last 7 days. Codes and counts, never records. */
export function HealthPanel({ tenantId }: { tenantId: string }) {
  const t = useTranslations("health");
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    void adminApi<Health>(`/businesses/${tenantId}/health`).then(setHealth);
  }, [tenantId]);

  if (!health) return null;
  const problems = [
    ...health.syncRefusals.map((row) => ({ what: t("refused"), code: row.code, total: row.total, lastAt: row.lastAt })),
    ...health.voiceProblems.map((row) => ({ what: row.event === "voice.download_failed" ? t("downloadFailed") : t("readFailed"), code: row.code, total: row.total, lastAt: row.lastAt })),
  ];
  return (
    <Section title={t("title")}>
      <dl className="grid gap-2 text-sm sm:grid-cols-2" data-testid="health-summary">
        <div>
          <dt className="text-muted">{t("lastActive")}</dt>
          <dd>{health.lastActive ? when(health.lastActive) : t("never")}</dd>
        </div>
        <div>
          <dt className="text-muted">{t("lastSync")}</dt>
          <dd>{health.lastSync ? when(health.lastSync) : t("never")}</dd>
        </div>
        <div>
          <dt className="text-muted">{t("sessions")}</dt>
          <dd className="tabular-nums">{health.openSessions}</dd>
        </div>
        <div>
          <dt className="text-muted">{t("devices")}</dt>
          <dd className="tabular-nums">{health.shopDevicesSignedIn}</dd>
        </div>
      </dl>
      {problems.length === 0 ? (
        <p className="text-sm text-muted">{t("none")}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("columns.what")}</TableHead>
              <TableHead>{t("columns.code")}</TableHead>
              <TableHead className="text-right">{t("columns.times")}</TableHead>
              <TableHead>{t("columns.last")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {problems.map((row) => (
              <TableRow key={`${row.what}-${row.code}`}>
                <TableCell>{row.what}</TableCell>
                <TableCell className="font-mono text-xs">{row.code ?? ""}</TableCell>
                <TableCell className="text-right tabular-nums">{row.total}</TableCell>
                <TableCell className="text-sm">{row.lastAt ? when(row.lastAt) : ""}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <p className="text-xs text-muted">{t("logsHint")}</p>
    </Section>
  );
}
