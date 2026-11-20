"use client";

import type { AdminRole } from "@bizora/contracts";
import { Badge, Button, Card, FormField, Input, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, useToast } from "@bizora/ui";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { useAdmin, useCan } from "@/components/admin-shell";
import { ReasonDialog } from "@/components/reason-dialog";
import { RolePicker } from "@/components/role-picker";
import { AdminApiError, adminApi } from "@/lib/admin-api";
import { when } from "@/lib/format";

type Member = { id: string; email: string; name: string; roles: AdminRole[]; status: "active" | "removed"; lastSignInAt: string | null };

function RolesChange({ member, onSaved }: { member: Member; onSaved: () => Promise<void> }) {
  const t = useTranslations("staff");
  const reason = useTranslations("reason");
  const [roles, setRoles] = useState<AdminRole[]>(member.roles);
  return (
    <ReasonDialog
      title={reason("changeRoles.title")}
      description={reason("changeRoles.description", { email: member.email })}
      done={reason("changeRoles.done")}
      trigger={
        <Button size="sm" variant="secondary">
          {t("change")}
        </Button>
      }
      onConfirm={async (text) => {
        await adminApi(`/staff/${member.id}`, { method: "PATCH", body: { roles, reason: text } });
        await onSaved();
      }}
    >
      <RolePicker idPrefix={`roles-${member.id}`} value={roles} onChange={setRoles} />
    </ReasonDialog>
  );
}

export default function StaffPage() {
  const t = useTranslations("staff");
  const reason = useTranslations("reason");
  const errors = useTranslations("errors");
  const me = useAdmin();
  const allowed = useCan("staff.manage");
  const toast = useToast();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [form, setForm] = useState<{ email: string; name: string; roles: AdminRole[] }>({ email: "", name: "", roles: ["support"] });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    setMembers(await adminApi<Member[]>("/staff"));
  }, []);

  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  if (!allowed) return <p role="alert">{errors("notAllowed")}</p>;

  async function add() {
    setFieldErrors({});
    setProblem(null);
    try {
      await adminApi("/staff", { method: "POST", body: form });
      toast.push(t("added"), "success");
      setForm({ email: "", name: "", roles: ["support"] });
      await load();
    } catch (error) {
      if (error instanceof AdminApiError) {
        setFieldErrors(Object.fromEntries(error.fields.map((field) => [field.field, field.message])));
        if (!error.fields.length) setProblem(error.message || errors("generic"));
      } else setProblem(errors("generic"));
    }
  }

  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
          <p className="text-muted">{t("lead")}</p>
        </div>
        {!members ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("name")}</TableHead>
                <TableHead>{t("roles")}</TableHead>
                <TableHead>{t("lastSignIn")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((member) => (
                <TableRow key={member.id}>
                  <TableCell>
                    <div className="font-medium">
                      {member.name}
                      {member.email === me.email ? (
                        <Badge tone="info" className="ml-2">
                          {t("you")}
                        </Badge>
                      ) : null}
                    </div>
                    <div className="text-muted">{member.email}</div>
                  </TableCell>
                  <TableCell>
                    {member.status === "removed" ? (
                      <Badge>{t("removed")}</Badge>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {member.roles.map((role) => (
                          <Badge key={role} tone={role === "super_admin" ? "info" : "neutral"}>
                            {t(`roleNames.${role}`)}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>{member.lastSignInAt ? when(member.lastSignInAt) : t("never")}</TableCell>
                  <TableCell>
                    {member.status === "active" ? (
                      <div className="flex justify-end gap-2">
                        <RolesChange member={member} onSaved={load} />
                        {member.email !== me.email ? (
                          <ReasonDialog
                            danger
                            title={reason("removeStaff.title")}
                            description={reason("removeStaff.description", { email: member.email })}
                            done={reason("removeStaff.done")}
                            trigger={
                              <Button size="sm" variant="ghost">
                                {t("remove")}
                              </Button>
                            }
                            onConfirm={async (text) => {
                              await adminApi(`/staff/${member.id}/remove`, { method: "POST", body: { reason: text } });
                              await load();
                            }}
                          />
                        ) : null}
                      </div>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      <Card className="h-fit space-y-4 p-5">
        <h2 className="font-semibold">{t("add")}</h2>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <FormField id="staff-email" label={t("email")} {...(fieldErrors.email ? { error: fieldErrors.email } : {})}>
            <Input id="staff-email" type="email" required value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
          </FormField>
          <FormField id="staff-name" label={t("name")} {...(fieldErrors.name ? { error: fieldErrors.name } : {})}>
            <Input id="staff-name" required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </FormField>
          <RolePicker idPrefix="new-staff" value={form.roles} onChange={(roles) => setForm({ ...form, roles })} />
          {problem ? (
            <p role="alert" className="text-sm text-danger">
              {problem}
            </p>
          ) : null}
          <Button type="submit" className="w-full" disabled={!form.roles.length}>
            {t("save")}
          </Button>
        </form>
      </Card>
    </div>
  );
}
