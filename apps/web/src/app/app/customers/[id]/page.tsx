"use client";

import { Permission, whatsAppHref } from "@bizora/contracts";
import { FormField, Input, PageHeader, SafeForm, Select, SubmitButton, Tab, TabPanel, TabsRoot, Textarea } from "@bizora/ui";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CustomerCredit, type CustomerCreditView } from "../../../../components/customer-credit";
import { RequireAccess } from "../../../../components/require-access";
import { can, customerMode } from "../../../../lib/access";
import { useAccess } from "../../../../lib/access-context";
import { api } from "../../../../lib/api";
import { dayKey, formatWhen } from "../../../../i18n/format";

type Customer = {
  id: string;
  name: string;
  phoneE164: string | null;
  isWalkIn: boolean;
  email: string | null;
  tags: string[];
  notesSummary: string | null;
  addressFormatted: string | null;
  credit: CustomerCreditView;
  owingMinor: string;
};
type Note = { id: string; body: string; createdAt: string };
type Followup = { id: string; reason: string; dueAt: string; status: string };
type Assignee = { membershipId: string; displayName: string | null; role: string };

function CustomerFullScreen() {
  const params = useParams<{ id: string }>();
  const t = useTranslations("customers");
  const access = useAccess();
  const canManage = can(access, Permission.CUSTOMERS_MANAGE);
  const canFollowUp = can(access, Permission.FOLLOWUPS_MANAGE);
  const followups = useTranslations("followups");
  const roles = useTranslations("roles");
  const common = useTranslations("common");
  const locale = useLocale();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [items, setItems] = useState<Followup[]>([]);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [business, setBusiness] = useState("");
  const [timezone, setTimezone] = useState("Africa/Lagos");
  const [tab, setTab] = useState("notes");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [dueOn, setDueOn] = useState("");
  const [assignee, setAssignee] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [missing, setMissing] = useState(false);

  async function load() {
    const [customerResponse, notesResponse, followupResponse, assigneeResponse, meResponse, dashboardResponse] = await Promise.all([
      api(`/api/v1/customers/${params.id}`),
      api(`/api/v1/customers/${params.id}/notes`),
      api(`/api/v1/customers/${params.id}/followups`),
      api("/api/v1/customers/assignees"),
      api("/api/v1/auth/me"),
      api("/api/v1/dashboard"),
    ]);
    if (customerResponse.status === 404) {
      setMissing(true);
      return;
    }
    if (customerResponse.ok) setCustomer((await customerResponse.json()).data?.customer ?? null);
    if (notesResponse.ok) setNotes((await notesResponse.json()).data?.items ?? []);
    if (followupResponse.ok) setItems((await followupResponse.json()).data?.items ?? []);
    if (assigneeResponse.ok) setAssignees((await assigneeResponse.json()).data?.items ?? []);
    if (meResponse.ok) setBusiness((await meResponse.json()).data?.organization?.name ?? "");
    if (dashboardResponse.ok) {
      const zone = String((await dashboardResponse.json()).data?.timezone ?? "Africa/Lagos");
      setTimezone(zone);
      setDueOn((current) => current || dayKey(new Date(), zone));
    }
  }

  useEffect(() => {
    void load();
  }, [params.id]);

  async function addNote() {
    setPending(true);
    setError(null);
    const response = await api(`/api/v1/customers/${params.id}/notes`, {
      method: "POST",
      body: JSON.stringify({ body: note }),
    });
    setPending(false);
    if (!response.ok) {
      setError(t("noteFailed"));
      return;
    }
    setNote("");
    setNotes((await response.json()).data?.items ?? []);
  }

  async function addFollowup() {
    setPending(true);
    setError(null);
    const response = await api(`/api/v1/customers/${params.id}/followups`, {
      method: "POST",
      body: JSON.stringify({ reason, dueOn, ...(assignee ? { assignedTo: assignee } : {}) }),
    });
    setPending(false);
    if (!response.ok) {
      setError(followups("failed"));
      return;
    }
    setReason("");
    await load();
  }

  async function updateFollowup(id: string, body: Record<string, unknown>) {
    setPending(true);
    await api(`/api/v1/followups/${id}`, { method: "PATCH", body: JSON.stringify(body) });
    setPending(false);
    await load();
  }

  async function remove() {
    setPending(true);
    const response = await api(`/api/v1/customers/${params.id}`, { method: "DELETE" });
    if (response.ok) {
      window.location.href = "/app/customers";
      return;
    }
    setError(t("deleteFailed"));
    setPending(false);
  }

  if (missing) {
    return (
      <div className="space-y-4">
        <p className="text-sm">{t("noResults")}</p>
        <Link href="/app/customers" className="text-sm font-medium text-primary">
          {t("back")}
        </Link>
      </div>
    );
  }

  if (!customer) return <p className="text-sm text-muted">{common("loading")}</p>;

  const greeting = customer.phoneE164 ? whatsAppHref(customer.phoneE164, t("whatsappGreeting", { name: customer.name, business })) : "";

  return (
    <div className="space-y-6">
      <PageHeader
        title={customer.name}
        description={customer.isWalkIn ? t("walkIn") : (customer.phoneE164 ?? undefined)}
        actions={
          <div className="flex flex-wrap gap-3 text-sm font-medium">
            {customer.phoneE164 ? (
              <a href={`tel:${customer.phoneE164}`} className="text-primary">
                {t("call")}
              </a>
            ) : null}
            {greeting ? (
              <a href={greeting} className="text-primary">
                {t("whatsapp")}
              </a>
            ) : null}
          </div>
        }
      />
      <div className="space-y-1 text-sm">
        {customer.email ? <p>{customer.email}</p> : null}
        {customer.addressFormatted ? <p>{customer.addressFormatted}</p> : null}
        {customer.tags.length > 0 ? <p>{customer.tags.join(", ")}</p> : null}
        {customer.notesSummary ? <p className="text-muted">{customer.notesSummary}</p> : null}
      </div>
      <CustomerCredit customerId={customer.id} credit={customer.credit} owingMinor={customer.owingMinor} onSaved={() => void load()} />
      {error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <TabsRoot
        value={tab}
        onValueChange={setTab}
        label={t("tabsLabel")}
        tabs={
          <>
            <Tab value="notes">{t("tabNotes")}</Tab>
            <Tab value="followups">{t("tabFollowups")}</Tab>
            <Tab value="purchases">{t("tabPurchases")}</Tab>
            <Tab value="owes">{t("tabOwes")}</Tab>
          </>
        }
      >
        <TabPanel value="notes">
          {notes.length === 0 ? <p className="text-sm text-muted">{t("noNotes")}</p> : null}
          <ul className="space-y-3">
            {notes.map((item) => (
              <li key={item.id} className="rounded-card border border-border bg-card px-4 py-3 text-sm">
                <p>{item.body}</p>
                <p className="mt-1 text-muted">{formatWhen(item.createdAt, locale, timezone)}</p>
              </li>
            ))}
          </ul>
          {canManage ? (
            <SafeForm className="mt-4 space-y-3" pending={pending} onSubmit={addNote}>
              <FormField id="note-body" label={t("noteLabel")}>
                <Textarea id="note-body" value={note} onChange={(event) => setNote(event.target.value)} required />
              </FormField>
              <SubmitButton pending={pending} pendingLabel={t("saving")}>
                {t("addNote")}
              </SubmitButton>
            </SafeForm>
          ) : null}
        </TabPanel>
        <TabPanel value="followups">
          {items.length === 0 ? <p className="text-sm text-muted">{followups("none")}</p> : null}
          <ul className="space-y-3">
            {items.map((item) => (
              <li key={item.id} className="rounded-card border border-border bg-card px-4 py-3 text-sm">
                <p className="font-medium">{item.reason}</p>
                <p className="text-muted">{formatWhen(item.dueAt, locale, timezone)}</p>
                {canFollowUp ? (
                  <div className="mt-2 flex gap-3">
                    <button type="button" className="font-medium text-primary" disabled={pending} onClick={() => void updateFollowup(item.id, { status: "done" })}>
                      {followups("done")}
                    </button>
                    <button
                      type="button"
                      className="font-medium text-primary"
                      disabled={pending}
                      onClick={() => void updateFollowup(item.id, { status: "snoozed", snoozeDays: 1 })}
                    >
                      {followups("snooze")}
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          {canFollowUp ? (
            <SafeForm className="mt-4 space-y-3" pending={pending} onSubmit={addFollowup}>
              <FormField id="followup-reason" label={followups("reason")}>
                <Input id="followup-reason" value={reason} onChange={(event) => setReason(event.target.value)} required />
              </FormField>
              <FormField id="followup-day" label={followups("day")}>
                <Input id="followup-day" type="date" value={dueOn} onChange={(event) => setDueOn(event.target.value)} required />
              </FormField>
              {assignees.length > 0 ? (
                <FormField id="followup-assignee" label={followups("assignee")}>
                  <Select id="followup-assignee" value={assignee} onChange={(event) => setAssignee(event.target.value)}>
                    <option value="">{followups("assignee")}</option>
                    {assignees.map((person) => (
                      <option key={person.membershipId} value={person.membershipId}>
                        {person.displayName} · {roles.has(person.role) ? roles(person.role) : person.role}
                      </option>
                    ))}
                  </Select>
                </FormField>
              ) : null}
              <SubmitButton pending={pending} pendingLabel={followups("adding")}>
                {followups("add")}
              </SubmitButton>
            </SafeForm>
          ) : null}
        </TabPanel>
        <TabPanel value="purchases">
          <p className="text-sm text-muted">{t("purchasesBody")}</p>
        </TabPanel>
        <TabPanel value="owes">
          <p className="text-sm text-muted">{t("owesBody")}</p>
        </TabPanel>
      </TabsRoot>
      {canManage ? (
        <SafeForm pending={pending} onSubmit={remove}>
          <SubmitButton pending={pending} pendingLabel={t("saving")} variant="danger">
            {t("delete")}
          </SubmitButton>
        </SafeForm>
      ) : null}
      <Link href="/app/customers" className="inline-block text-sm font-medium text-primary">
        {t("back")}
      </Link>
    </div>
  );
}

type LimitedCustomer = { id: string; name: string; isWalkIn: boolean; phoneLast4: string | null; credit: CustomerCreditView; owingMinor: string };

/** Cashier view of one customer: name and the end of the phone number only. */
function CustomerLimitedScreen() {
  const params = useParams<{ id: string }>();
  const t = useTranslations("customers");
  const common = useTranslations("common");
  const [customer, setCustomer] = useState<LimitedCustomer | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    void (async () => {
      const response = await api(`/api/v1/customers/${params.id}`);
      if (!response.ok) {
        setMissing(true);
        return;
      }
      setCustomer((await response.json()).data?.customer ?? null);
    })();
  }, [params.id]);

  if (missing) return <p className="text-sm">{t("noResults")}</p>;
  if (!customer) return <p className="text-sm text-muted">{common("loading")}</p>;
  return (
    <div className="space-y-4">
      <PageHeader
        title={customer.name}
        description={customer.isWalkIn || !customer.phoneLast4 ? t("walkIn") : t("phoneEnds", { digits: customer.phoneLast4 })}
      />
      <p className="text-xs text-muted">{t("limitedNote")}</p>
      <CustomerCredit customerId={customer.id} credit={customer.credit} owingMinor={customer.owingMinor} onSaved={() => undefined} />
      <Link href="/app/customers" className="inline-block text-sm font-medium text-primary">
        {t("back")}
      </Link>
    </div>
  );
}

export default function CustomerPage() {
  const mode = customerMode(useAccess());
  if (mode === "list") return <CustomerFullScreen />;
  if (mode === "lookup") return <CustomerLimitedScreen />;
  return (
    <RequireAccess anyOf={[Permission.CUSTOMERS_READ, Permission.CUSTOMERS_LOOKUP]}>
      <CustomerFullScreen />
    </RequireAccess>
  );
}
