"use client";

import { Badge, Button, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@bizora/ui";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { useCan } from "@/components/admin-shell";
import { ReasonDialog } from "@/components/reason-dialog";
import { Section } from "@/components/section";
import { AdminApiError, adminApi } from "@/lib/admin-api";
import { day, when } from "@/lib/format";

type Person = {
  id: string;
  name: string;
  email: string | null;
  signsInWith: string[];
  emailVerified: boolean;
  signedUpAt: string;
  signedInDevices: number;
  lastSeenAt: string | null;
  businesses: { tenantId: string; business: string; role: string; status: string }[];
  invitations: { id: string; role: string; business: string; tenantId: string; expiresAt: string; expired: boolean }[];
};

export default function PersonPage() {
  const t = useTranslations("person");
  const reason = useTranslations("reason");
  const errors = useTranslations("errors");
  const business = useTranslations("business");
  const { id } = useParams<{ id: string }>();
  const [person, setPerson] = useState<Person | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const canAct = useCan("support.act");

  const load = useCallback(async () => {
    try {
      setPerson(await adminApi<Person>(`/people/${id}`));
    } catch (error) {
      setProblem(error instanceof AdminApiError && error.status === 404 ? errors("notFound") : errors("generic"));
    }
  }, [id, errors]);

  useEffect(() => {
    void load();
  }, [load]);

  if (problem) return <p role="alert">{problem}</p>;
  if (!person) return <Skeleton className="h-64 w-full" />;
  const methods = person.signsInWith.map((method) => (t.has(`methods.${method}`) ? t(`methods.${method}`) : method)).join(", ");

  return (
    <div className="space-y-10">
      <div className="space-y-3">
        <Link href="/" className="text-sm text-muted hover:underline">
          {t("back")}
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight">{person.name}</h1>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-muted">
          {person.email ? <span className="text-fg">{person.email}</span> : null}
          <Badge tone={person.emailVerified ? "success" : "warning"}>{person.emailVerified ? t("confirmed") : t("unconfirmed")}</Badge>
          <span>{t("signsInWith", { methods })}</span>
          <span>{t("signedUp", { date: day(person.signedUpAt) })}</span>
          <span>{person.lastSeenAt ? t("lastSeen", { date: when(person.lastSeenAt) }) : t("neverSeen")}</span>
          <span>{t("devices", { count: person.signedInDevices })}</span>
        </div>
      </div>

      {canAct ? (
        <Section title={t("actions")}>
          <div className="flex flex-wrap items-start gap-3">
            {person.email && !person.emailVerified ? (
              <ReasonDialog
                title={reason("resendVerification.title")}
                description={reason("resendVerification.description", { email: person.email })}
                done={reason("resendVerification.done")}
                trigger={<Button variant="secondary">{t("resendVerification")}</Button>}
                onConfirm={async (text) => {
                  await adminApi(`/people/${person.id}/resend-verification`, { method: "POST", body: { reason: text } });
                }}
              />
            ) : null}
            <div className="space-y-1">
              <ReasonDialog
                danger
                title={reason("signOutEverywhere.title")}
                description={reason("signOutEverywhere.description", { name: person.name })}
                done={reason("signOutEverywhere.done")}
                trigger={<Button variant="secondary">{t("signOutEverywhere")}</Button>}
                onConfirm={async (text) => {
                  await adminApi(`/people/${person.id}/sign-out-everywhere`, { method: "POST", body: { reason: text } });
                  await load();
                }}
              />
              <p className="max-w-sm text-xs text-muted">{t("signOutHint")}</p>
            </div>
          </div>
        </Section>
      ) : null}

      <Section title={t("businesses")}>
        {person.businesses.length === 0 ? (
          <p className="text-sm text-muted">{t("none")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{business("columns.business")}</TableHead>
                <TableHead>{business("columns.role")}</TableHead>
                <TableHead>{business("columns.status")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {person.businesses.map((place) => (
                <TableRow key={place.tenantId}>
                  <TableCell>
                    <Link href={`/businesses/${place.tenantId}`} className="font-medium text-primary underline-offset-2 hover:underline">
                      {place.business}
                    </Link>
                  </TableCell>
                  <TableCell>{place.role}</TableCell>
                  <TableCell>{business.has(`membership.${place.status}`) ? business(`membership.${place.status}`) : place.status}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section title={t("invitations")}>
        {person.invitations.length === 0 ? (
          <p className="text-sm text-muted">{t("none")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{business("columns.business")}</TableHead>
                <TableHead>{business("columns.role")}</TableHead>
                <TableHead>{business("columns.expires")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {person.invitations.map((invite) => (
                <TableRow key={invite.id}>
                  <TableCell>
                    <Link href={`/businesses/${invite.tenantId}`} className="text-primary underline-offset-2 hover:underline">
                      {invite.business}
                    </Link>
                  </TableCell>
                  <TableCell>{invite.role}</TableCell>
                  <TableCell>{invite.expired ? <Badge tone="warning">{business("expired")}</Badge> : day(invite.expiresAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
    </div>
  );
}
