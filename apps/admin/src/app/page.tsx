"use client";

import { Badge, Button, Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@bizora/ui";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { adminApi } from "@/lib/admin-api";
import { day } from "@/lib/format";

type BusinessRow = { id: string; name: string; handle: string; plan: string | null; signedUpAt: string; openShops: number; owner: { name: string; email: string | null } | null };
type PersonRow = { id: string; name: string; email: string | null; emailVerified: boolean; businesses: { tenantId: string; business: string; role: string }[] };
type InviteRow = { id: string; email: string; role: string; tenantId: string; business: string; expiresAt: string; expired: boolean };
type Mode = "businesses" | "people";

export default function FindPage() {
  const t = useTranslations("find");
  const [mode, setMode] = useState<Mode>("businesses");
  const [q, setQ] = useState("");
  const [searched, setSearched] = useState("");
  const [businesses, setBusinesses] = useState<BusinessRow[] | null>(null);
  const [people, setPeople] = useState<{ people: PersonRow[]; invitations: InviteRow[] } | null>(null);

  const run = useCallback(async (which: Mode, term: string) => {
    setSearched(term);
    if (which === "businesses") setBusinesses(await adminApi<BusinessRow[]>(`/businesses?q=${encodeURIComponent(term)}`));
    else setPeople(await adminApi<{ people: PersonRow[]; invitations: InviteRow[] }>(`/people?q=${encodeURIComponent(term)}`));
  }, []);

  useEffect(() => {
    void run("businesses", "");
  }, [run]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      <form
        role="search"
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void run(mode, q.trim());
        }}
      >
        <div className="flex rounded-control border border-border p-0.5" role="group" aria-label={t("title")}>
          {(["businesses", "people"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={mode === option}
              onClick={() => {
                setMode(option);
                if (option === "businesses" && !businesses) void run("businesses", "");
              }}
              className={`rounded-control px-4 py-2 text-sm ${mode === option ? "bg-primary text-primary-fg" : "text-muted hover:bg-sidebar"}`}
            >
              {t(option)}
            </button>
          ))}
        </div>
        <Input
          className="min-w-72 flex-1"
          value={q}
          onChange={(event) => setQ(event.target.value)}
          aria-label={mode === "businesses" ? t("searchBusinesses") : t("searchPeople")}
          placeholder={mode === "businesses" ? t("searchBusinesses") : t("searchPeople")}
        />
        <Button type="submit">{t("search")}</Button>
      </form>

      {mode === "businesses" ? (
        <section className="space-y-3">
          {!searched ? <h2 className="text-sm font-medium text-muted">{t("recent")}</h2> : null}
          {businesses && businesses.length === 0 ? <p className="text-muted">{t("noBusinesses")}</p> : null}
          {businesses && businesses.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.business")}</TableHead>
                  <TableHead>{t("columns.owner")}</TableHead>
                  <TableHead>{t("columns.plan")}</TableHead>
                  <TableHead className="text-right">{t("columns.shops")}</TableHead>
                  <TableHead>{t("columns.signedUp")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {businesses.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <Link href={`/businesses/${row.id}`} className="font-medium text-primary underline-offset-2 hover:underline">
                        {row.name}
                      </Link>
                      <div className="admin-mono text-muted">{row.handle}</div>
                    </TableCell>
                    <TableCell>{row.owner ? (row.owner.email ?? row.owner.name) : t("noOwner")}</TableCell>
                    <TableCell>{row.plan ?? ""}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.openShops}</TableCell>
                    <TableCell>{day(row.signedUpAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
        </section>
      ) : (
        <section className="space-y-6">
          {!people ? <p className="text-muted">{t("typeToSearch")}</p> : null}
          {people && people.people.length === 0 && people.invitations.length === 0 ? <p className="text-muted">{t("noPeople")}</p> : null}
          {people && people.people.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.person")}</TableHead>
                  <TableHead>{t("columns.email")}</TableHead>
                  <TableHead>{t("columns.worksAt")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {people.people.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <Link href={`/people/${row.id}`} className="font-medium text-primary underline-offset-2 hover:underline">
                        {row.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      {row.email}
                      {!row.emailVerified ? (
                        <Badge tone="warning" className="ml-2">
                          {t("unconfirmed")}
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      {row.businesses.map((place) => (
                        <Link key={place.tenantId} href={`/businesses/${place.tenantId}`} className="mr-3 underline-offset-2 hover:underline">
                          {place.business}
                        </Link>
                      ))}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
          {people && people.invitations.length > 0 ? (
            <div className="space-y-2">
              <h2 className="font-medium">{t("invitations")}</h2>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("columns.email")}</TableHead>
                    <TableHead>{t("columns.invitedTo")}</TableHead>
                    <TableHead>{t("columns.role")}</TableHead>
                    <TableHead>{t("columns.expires")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {people.invitations.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>{row.email}</TableCell>
                      <TableCell>
                        <Link href={`/businesses/${row.tenantId}`} className="text-primary underline-offset-2 hover:underline">
                          {row.business}
                        </Link>
                      </TableCell>
                      <TableCell>{row.role}</TableCell>
                      <TableCell>{day(row.expiresAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}
        </section>
      )}
    </div>
  );
}
