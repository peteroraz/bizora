"use client";

import { Button, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@bizora/ui";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { useCan } from "@/components/admin-shell";
import { adminApi } from "@/lib/admin-api";
import { when } from "@/lib/format";

type Entry = { id: string; at: string; staffEmail: string; action: string; targetType: string | null; targetId: string | null; tenantId: string | null; reason: string | null };

export default function AuditPage() {
  const t = useTranslations("audit");
  const columns = useTranslations("business.columns");
  const errors = useTranslations("errors");
  const allowed = useCan("audit.read");
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [more, setMore] = useState(false);

  const load = useCallback(async (before?: string) => {
    const page = await adminApi<Entry[]>(`/audit${before ? `?before=${encodeURIComponent(before)}` : ""}`);
    setEntries((current) => (before && current ? [...current, ...page] : page));
    setMore(page.length === 50);
  }, []);

  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  if (!allowed) return <p role="alert">{errors("notAllowed")}</p>;
  const label = (action: string) => {
    const key = `actions.${action.replaceAll(".", "_")}`;
    return t.has(key) ? t(key) : action;
  };
  const target = (entry: Entry) => {
    if (entry.targetType === "person" && entry.targetId) return `/people/${entry.targetId}`;
    if (entry.tenantId) return `/businesses/${entry.tenantId}`;
    return null;
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted">{t("lead")}</p>
      </div>
      {!entries ? (
        <Skeleton className="h-64 w-full" />
      ) : entries.length === 0 ? (
        <p className="text-muted">{t("empty")}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{columns("when")}</TableHead>
              <TableHead>{columns("who")}</TableHead>
              <TableHead>{columns("what")}</TableHead>
              <TableHead>{columns("why")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry) => {
              const href = target(entry);
              return (
                <TableRow key={entry.id}>
                  <TableCell className="whitespace-nowrap">{when(entry.at)}</TableCell>
                  <TableCell>{entry.staffEmail}</TableCell>
                  <TableCell>
                    {href ? (
                      <Link href={href} className="text-primary underline-offset-2 hover:underline">
                        {label(entry.action)}
                      </Link>
                    ) : (
                      label(entry.action)
                    )}
                  </TableCell>
                  <TableCell>{entry.reason ?? ""}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      {more && entries ? (
        <Button variant="secondary" onClick={() => void load(entries.at(-1)?.at)}>
          {t("more")}
        </Button>
      ) : null}
    </div>
  );
}
