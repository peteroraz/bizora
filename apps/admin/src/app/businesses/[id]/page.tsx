"use client";

import { Badge, Button, buttonVariants, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@bizora/ui";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { useCan } from "@/components/admin-shell";
import { FeaturesPanel } from "@/components/features-panel";
import { HealthPanel } from "@/components/health-panel";
import { LimitsPanel } from "@/components/limits-panel";
import { ReasonDialog } from "@/components/reason-dialog";
import { Section } from "@/components/section";
import { AdminApiError, adminApi } from "@/lib/admin-api";
import { day, size, when } from "@/lib/format";

type Profile = {
  id: string;
  name: string;
  handle: string;
  sample?: boolean;
  phone: string | null;
  signedUpAt: string;
  setUpAt: string | null;
  lastActivityAt: string | null;
  plan: { code: string; name: string; since: string } | null;
  businesses: { id: string; name: string; type: string | null; country: string; currency: string; timezone: string }[];
  shops: { id: string; name: string; business: string | null; status: "open" | "locked" | "closed"; aiReadsToday: number; aiReads30Days: number }[];
  people: { userId: string; name: string; email: string | null; signsInWith: "email" | "pin"; role: string; status: string; shop: string | null; emailVerified: boolean; lastSeenAt: string | null }[];
  invitations: { id: string; email: string; role: string; shop: string | null; sentAt: string; expiresAt: string; expired: boolean }[];
  devices: { id: string; name: string; shop: string | null; addedAt: string; lastSeenAt: string | null; status: "active" | "suspended" | "stopped" }[];
  storage: { productPhotos: number; bytes: number };
  usage: { sales30Days: number; products: number; customers: number };
  supportHistory: { id: string; at: string; staffEmail: string; action: string; reason: string | null }[];
};

const shopTone = { open: "success", locked: "warning", closed: "neutral" } as const;
const deviceTone = { active: "success", suspended: "warning", stopped: "neutral" } as const;

export default function BusinessPage() {
  const t = useTranslations("business");
  const reason = useTranslations("reason");
  const audit = useTranslations("audit");
  const errors = useTranslations("errors");
  const { id } = useParams<{ id: string }>();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const canAct = useCan("support.act");
  const canStop = useCan("devices.stop");
  const canView = useCan("records.read");
  const router = useRouter();
  const [view, setView] = useState<{ expiresAt: string } | null>(null);

  useEffect(() => {
    if (!canView) return;
    void adminApi<{ view: { expiresAt: string } | null }>(`/businesses/${id}/support-view`)
      .then((data) => setView(data.view))
      .catch(() => undefined);
  }, [canView, id]);

  const load = useCallback(async () => {
    try {
      setProfile(await adminApi<Profile>(`/businesses/${id}`));
    } catch (error) {
      setProblem(error instanceof AdminApiError && error.status === 404 ? errors("notFound") : errors("generic"));
    }
  }, [id, errors]);

  useEffect(() => {
    void load();
  }, [load]);

  if (problem) return <p role="alert">{problem}</p>;
  if (!profile) return <Skeleton className="h-64 w-full" />;
  const none = <p className="text-sm text-muted">{t("none")}</p>;
  const actionLabel = (action: string) => {
    const key = `actions.${action.replaceAll(".", "_")}`;
    return audit.has(key) ? audit(key) : action;
  };

  return (
    <div className="space-y-10">
      <div className="space-y-3">
        <Link href="/" className="text-sm text-muted hover:underline">
          {t("back")}
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight">{profile.name}</h1>
        {profile.sample ? <p className="text-sm text-info" data-testid="sample-business">{t("sample")}</p> : null}
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted">
          <span>{t("link", { handle: profile.handle })}</span>
          <span>{profile.plan ? t("plan", { plan: profile.plan.name }) : t("noPlan")}</span>
          <span>{t("signedUp", { date: day(profile.signedUpAt) })}</span>
          <span>{profile.setUpAt ? t("setUp", { date: day(profile.setUpAt) }) : t("notSetUp")}</span>
          <span>{profile.lastActivityAt ? t("lastActive", { date: when(profile.lastActivityAt) }) : t("neverActive")}</span>
        </div>
        <p className="max-w-prose rounded-card border border-border bg-sidebar px-4 py-2 text-sm">{t("privacy")}</p>
      </div>

      {canView ? (
        <Section title={t("supportView")}>
          <p className="max-w-prose text-sm text-muted">{t("supportViewLead")}</p>
          {view ? (
            <Link href={`/businesses/${profile.id}/records`} className={buttonVariants({})} data-testid="continue-support-view">
              {t("continueSupportView", { time: new Date(view.expiresAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) })}
            </Link>
          ) : (
            <ReasonDialog
              title={reason("openSupportView.title")}
              description={reason("openSupportView.description", { name: profile.name })}
              done={reason("openSupportView.done")}
              trigger={<Button>{t("openSupportView")}</Button>}
              onConfirm={async (text) => {
                await adminApi(`/businesses/${profile.id}/support-view`, { method: "POST", body: { reason: text } });
                router.push(`/businesses/${profile.id}/records`);
              }}
            />
          )}
        </Section>
      ) : null}

      <Section title={t("usage")}>
        <p className="text-sm" data-testid="business-usage">
          {t("usageLine", { sales: profile.usage.sales30Days, products: profile.usage.products, customers: profile.usage.customers })}
        </p>
      </Section>

      <LimitsPanel tenantId={profile.id} />

      <FeaturesPanel tenantId={profile.id} />

      <HealthPanel tenantId={profile.id} />

      <Section title={t("businesses")}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("columns.name")}</TableHead>
              <TableHead>{t("columns.type")}</TableHead>
              <TableHead>{t("columns.country")}</TableHead>
              <TableHead>{t("columns.currency")}</TableHead>
              <TableHead>{t("columns.timezone")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {profile.businesses.map((business) => (
              <TableRow key={business.id}>
                <TableCell className="font-medium">{business.name}</TableCell>
                <TableCell>{business.type ?? ""}</TableCell>
                <TableCell>{business.country}</TableCell>
                <TableCell>{business.currency}</TableCell>
                <TableCell>{business.timezone}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      <Section title={t("shops")} aside={<span className="text-sm text-muted">{t("storage", { photos: profile.storage.productPhotos, size: size(profile.storage.bytes) })}</span>}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("columns.name")}</TableHead>
              <TableHead>{t("columns.business")}</TableHead>
              <TableHead>{t("columns.status")}</TableHead>
              <TableHead className="text-right">{t("columns.reads")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {profile.shops.map((shop) => (
              <TableRow key={shop.id}>
                <TableCell className="font-medium">{shop.name}</TableCell>
                <TableCell>{shop.business ?? ""}</TableCell>
                <TableCell>
                  <Badge tone={shopTone[shop.status]}>{t(`shopStatus.${shop.status}`)}</Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {shop.aiReadsToday} / {shop.aiReads30Days}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      <Section title={t("people")}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("columns.name")}</TableHead>
              <TableHead>{t("columns.role")}</TableHead>
              <TableHead>{t("columns.shop")}</TableHead>
              <TableHead>{t("columns.signsIn")}</TableHead>
              <TableHead>{t("columns.lastSeen")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {profile.people.map((person) => (
              <TableRow key={person.userId}>
                <TableCell>
                  <div className="font-medium">{person.name}</div>
                  {person.email ? <div className="text-muted">{person.email}</div> : null}
                </TableCell>
                <TableCell>
                  {person.role}
                  {person.status !== "ACTIVE" ? (
                    <Badge tone="warning" className="ml-2">
                      {t.has(`membership.${person.status}`) ? t(`membership.${person.status}`) : person.status}
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell>{person.shop ?? t("allShops")}</TableCell>
                <TableCell>{t(`signsIn.${person.signsInWith}`)}</TableCell>
                <TableCell>{person.lastSeenAt ? when(person.lastSeenAt) : t("never")}</TableCell>
                <TableCell className="text-right">
                  {person.signsInWith === "email" ? (
                    <Link href={`/people/${person.userId}`} className="text-primary underline-offset-2 hover:underline">
                      {t("openPerson")}
                    </Link>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      <Section title={t("invitations")}>
        {profile.invitations.length === 0 ? (
          none
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("columns.email")}</TableHead>
                <TableHead>{t("columns.role")}</TableHead>
                <TableHead>{t("columns.shop")}</TableHead>
                <TableHead>{t("columns.sent")}</TableHead>
                <TableHead>{t("columns.expires")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {profile.invitations.map((invite) => (
                <TableRow key={invite.id}>
                  <TableCell>{invite.email}</TableCell>
                  <TableCell>{invite.role}</TableCell>
                  <TableCell>{invite.shop ?? t("allShops")}</TableCell>
                  <TableCell>{day(invite.sentAt)}</TableCell>
                  <TableCell>{invite.expired ? <Badge tone="warning">{t("expired")}</Badge> : day(invite.expiresAt)}</TableCell>
                  <TableCell className="text-right">
                    {canAct ? (
                      <ReasonDialog
                        title={reason("resendInvitation.title")}
                        description={reason("resendInvitation.description", { email: invite.email })}
                        done={reason("resendInvitation.done")}
                        trigger={
                          <Button size="sm" variant="secondary">
                            {t("resendInvitation")}
                          </Button>
                        }
                        onConfirm={async (text) => {
                          await adminApi(`/invitations/${invite.id}/resend`, { method: "POST", body: { reason: text } });
                          await load();
                        }}
                      />
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section title={t("devices")}>
        {profile.devices.length === 0 ? (
          none
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("columns.name")}</TableHead>
                <TableHead>{t("columns.shop")}</TableHead>
                <TableHead>{t("columns.added")}</TableHead>
                <TableHead>{t("columns.lastSeen")}</TableHead>
                <TableHead>{t("columns.status")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {profile.devices.map((device) => (
                <TableRow key={device.id}>
                  <TableCell className="font-medium">{device.name}</TableCell>
                  <TableCell>{device.shop ?? ""}</TableCell>
                  <TableCell>{day(device.addedAt)}</TableCell>
                  <TableCell>{device.lastSeenAt ? when(device.lastSeenAt) : t("never")}</TableCell>
                  <TableCell>
                    <Badge tone={deviceTone[device.status]}>{t(`deviceStatus.${device.status}`)}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {canStop && device.status !== "stopped" ? (
                      <ReasonDialog
                        danger
                        title={reason("stopDevice.title")}
                        description={reason("stopDevice.description", { name: device.name })}
                        done={reason("stopDevice.done")}
                        trigger={
                          <Button size="sm" variant="secondary">
                            {t("stopDevice")}
                          </Button>
                        }
                        onConfirm={async (text) => {
                          await adminApi(`/devices/${device.id}/stop`, { method: "POST", body: { reason: text } });
                          await load();
                        }}
                      />
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section title={t("history")}>
        {profile.supportHistory.length === 0 ? (
          none
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("columns.when")}</TableHead>
                <TableHead>{t("columns.who")}</TableHead>
                <TableHead>{t("columns.what")}</TableHead>
                <TableHead>{t("columns.why")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {profile.supportHistory.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="whitespace-nowrap">{when(entry.at)}</TableCell>
                  <TableCell>{entry.staffEmail}</TableCell>
                  <TableCell>{actionLabel(entry.action)}</TableCell>
                  <TableCell>{entry.reason ?? ""}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
    </div>
  );
}
