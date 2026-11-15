"use client";

import { STAFF_ROLES, isWeakPin } from "@bizora/contracts";
import { Badge, Button, Card, EmptyState, FormField, Input, PageHeader, SafeForm, Select, SubmitButton } from "@bizora/ui";
import { useFormatter, useTranslations } from "next-intl";
import { FormEvent, useEffect, useState } from "react";
import { api } from "../../../lib/api";

type Staff = {
  id: string;
  displayName: string;
  role: string;
  branchId: string | null;
  branchName: string | null;
  phoneE164: string | null;
  status: "active" | "inactive";
};
type Device = {
  id: string;
  name: string;
  branchName: string | null;
  lastSeenAt: string | null;
  status: "active" | "suspended" | "revoked";
};
type Branch = { id: string; name: string };
type Plan = {
  plan: { code: string; name: string };
  limits: { max_branches: number; max_staff: number; max_devices: number };
  usage: { max_branches: number; max_staff: number; max_devices: number };
};

function pinProblem(pin: string, confirm: string): "pinFormat" | "pinWeak" | "pinMismatch" | null {
  if (!/^\d{4,6}$/.test(pin)) return "pinFormat";
  if (isWeakPin(pin)) return "pinWeak";
  if (pin !== confirm) return "pinMismatch";
  return null;
}

export default function StaffPage() {
  const t = useTranslations("staff");
  const roles = useTranslations("roles");
  const common = useTranslations("common");
  const format = useFormatter();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [thisDeviceEnrolled, setThisDeviceEnrolled] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [resetFor, setResetFor] = useState<Staff | null>(null);

  async function refresh() {
    const [staffResponse, deviceResponse, branchResponse, planResponse, shopResponse] = await Promise.all([
      api("/api/v1/staff"),
      api("/api/v1/shop-devices"),
      api("/api/v1/branches"),
      api("/api/v1/plan"),
      fetch("/api/v1/shop/device", { credentials: "include" }),
    ]);
    if (staffResponse.status === 403) {
      setAllowed(false);
      return;
    }
    setAllowed(true);
    setStaff(staffResponse.ok ? ((await staffResponse.json()).data?.items ?? []) : []);
    setDevices(deviceResponse.ok ? ((await deviceResponse.json()).data?.items ?? []) : []);
    setBranches(branchResponse.ok ? ((await branchResponse.json()).data?.items ?? []) : []);
    setPlan(planResponse.ok ? ((await planResponse.json()).data ?? null) : null);
    setThisDeviceEnrolled(shopResponse.ok);
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function run(action: () => Promise<Response>, success: string) {
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      const response = await action();
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message = payload?.error?.fieldErrors?.[0]?.message && payload?.error?.code === "VALIDATION_ERROR"
          ? payload.error.fieldErrors[0].message
          : (payload?.error?.message ?? t("actionFailed"));
        setError(payload?.error?.code === "PLAN_LIMIT" ? `${message} ${t("upgradeHint")}` : message);
        return false;
      }
      setNotice(success);
      await refresh();
      return true;
    } finally {
      setPending(false);
    }
  }

  async function addStaff(event: FormEvent<HTMLFormElement>) {
    const form = event.currentTarget;
    const data = new FormData(form);
    const pin = String(data.get("pin") ?? "");
    const problem = pinProblem(pin, String(data.get("confirmPin") ?? ""));
    if (problem) {
      setError(t(problem));
      return;
    }
    const phone = String(data.get("phone") ?? "").trim();
    const ok = await run(
      () =>
        api("/api/v1/staff", {
          method: "POST",
          body: JSON.stringify({
            displayName: data.get("displayName"),
            role: data.get("role"),
            branchId: data.get("branchId"),
            ...(phone ? { phoneE164: phone } : {}),
            pin,
          }),
        }),
      t("added"),
    );
    if (ok) form.reset();
  }

  async function savePin(event: FormEvent<HTMLFormElement>) {
    if (!resetFor) return;
    const data = new FormData(event.currentTarget);
    const pin = String(data.get("pin") ?? "");
    const problem = pinProblem(pin, String(data.get("confirmPin") ?? ""));
    if (problem) {
      setError(t(problem));
      return;
    }
    const ok = await run(
      () => api(`/api/v1/staff/${resetFor.id}/pin`, { method: "POST", body: JSON.stringify({ pin }) }),
      t("pinReset", { name: resetFor.displayName }),
    );
    if (ok) setResetFor(null);
  }

  async function enableShopMode(event: FormEvent<HTMLFormElement>) {
    const data = new FormData(event.currentTarget);
    const ok = await run(
      () =>
        api("/api/v1/shop-devices", {
          method: "POST",
          body: JSON.stringify({ name: data.get("deviceName"), branchId: data.get("branchId") || undefined }),
        }),
      t("enable"),
    );
    if (ok) window.location.assign("/shop");
  }

  async function exitShopMode() {
    const ok = await run(() => api("/api/v1/shop-devices/current/exit", { method: "POST" }), t("exited"));
    if (ok) setThisDeviceEnrolled(false);
  }

  function roleLabel(role: string) {
    return roles.has(role) ? roles(role) : role;
  }

  function deviceStatus(device: Device) {
    if (device.status === "suspended") return <Badge tone="warning">{t("deviceSuspended")}</Badge>;
    if (device.status === "revoked") return <Badge>{t("deviceRevoked")}</Badge>;
    return <Badge tone="success">{t("deviceActive")}</Badge>;
  }

  if (allowed === false) {
    return <EmptyState title={t("title")} description={t("noPermission")} />;
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("description")} />
      {notice ? (
        <p className="rounded-control border border-success bg-success-bg px-3 py-2 text-sm text-success" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="rounded-control border border-danger bg-danger-bg px-3 py-2 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}

      {plan ? (
        <Card className="space-y-1">
          <h2 className="text-lg font-semibold">{t("planTitle")}</h2>
          <p className="text-sm text-muted">
            {t("planUsage", {
              plan: plan.plan.name,
              staff: plan.usage.max_staff,
              maxStaff: plan.limits.max_staff,
              branches: plan.usage.max_branches,
              maxBranches: plan.limits.max_branches,
              devices: plan.usage.max_devices,
              maxDevices: plan.limits.max_devices,
            })}
          </p>
        </Card>
      ) : null}

      <Card className="space-y-4">
        <h2 className="text-lg font-semibold">{t("listTitle")}</h2>
        {staff.length === 0 ? <p className="text-sm text-muted">{t("listEmpty")}</p> : null}
        <ul className="divide-y divide-border">
          {staff.map((member) => (
            <li key={member.id} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{member.displayName}</p>
                <p className="text-sm text-muted">
                  {roleLabel(member.role)}
                  {member.branchName ? ` · ${member.branchName}` : ""}
                </p>
              </div>
              <Badge tone={member.status === "active" ? "success" : "neutral"}>
                {member.status === "active" ? t("statusActive") : t("statusInactive")}
              </Badge>
              <Button size="sm" variant="outline" disabled={pending} onClick={() => setResetFor(member)}>
                {t("resetPin")}
              </Button>
              {member.status === "active" ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() =>
                    void run(
                      () => api(`/api/v1/staff/${member.id}/deactivate`, { method: "POST" }),
                      t("deactivated", { name: member.displayName }),
                    )
                  }
                >
                  {t("deactivate")}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() =>
                    void run(
                      () => api(`/api/v1/staff/${member.id}/reactivate`, { method: "POST" }),
                      t("reactivated", { name: member.displayName }),
                    )
                  }
                >
                  {t("reactivate")}
                </Button>
              )}
            </li>
          ))}
        </ul>
        {resetFor ? (
          <SafeForm className="grid gap-3 rounded-control border border-border p-4 sm:grid-cols-2" pending={pending} onSubmit={savePin}>
            <h3 className="font-medium sm:col-span-2">{t("resetPinTitle", { name: resetFor.displayName })}</h3>
            <FormField id="reset-pin" label={t("pin")} hint={t("pinHint")}>
              <Input id="reset-pin" name="pin" type="password" inputMode="numeric" autoComplete="off" maxLength={6} required />
            </FormField>
            <FormField id="reset-confirm" label={t("confirmPin")}>
              <Input id="reset-confirm" name="confirmPin" type="password" inputMode="numeric" autoComplete="off" maxLength={6} required />
            </FormField>
            <div className="flex gap-2 sm:col-span-2">
              <SubmitButton pending={pending} pendingLabel={common("saving")}>
                {t("resetPinSave")}
              </SubmitButton>
              <Button type="button" variant="ghost" onClick={() => setResetFor(null)}>
                {common("back")}
              </Button>
            </div>
          </SafeForm>
        ) : null}
      </Card>

      <Card className="space-y-4">
        <h2 className="text-lg font-semibold">{t("addTitle")}</h2>
        <SafeForm className="grid gap-3 sm:grid-cols-2" pending={pending} onSubmit={addStaff}>
          <FormField id="staff-name" label={t("name")}>
            <Input id="staff-name" name="displayName" maxLength={120} required />
          </FormField>
          <FormField id="staff-role" label={t("role")}>
            <Select id="staff-role" name="role" defaultValue="SALES">
              {STAFF_ROLES.map((role) => (
                <option key={role} value={role}>
                  {roleLabel(role)}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField id="staff-branch" label={t("shop")}>
            <Select id="staff-branch" name="branchId" required>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField id="staff-phone" label={t("phone")}>
            <Input id="staff-phone" name="phone" type="tel" inputMode="tel" autoComplete="off" />
          </FormField>
          <FormField id="staff-pin" label={t("pin")} hint={t("pinHint")}>
            <Input id="staff-pin" name="pin" type="password" inputMode="numeric" autoComplete="off" maxLength={6} required />
          </FormField>
          <FormField id="staff-confirm" label={t("confirmPin")}>
            <Input id="staff-confirm" name="confirmPin" type="password" inputMode="numeric" autoComplete="off" maxLength={6} required />
          </FormField>
          <div className="sm:col-span-2">
            <SubmitButton pending={pending} pendingLabel={t("adding")}>
              {t("add")}
            </SubmitButton>
          </div>
        </SafeForm>
      </Card>

      <Card className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">{t("devicesTitle")}</h2>
          <p className="text-sm text-muted">{t("devicesLead")}</p>
        </div>
        {devices.length === 0 ? <p className="text-sm text-muted">{t("devicesEmpty")}</p> : null}
        <ul className="divide-y divide-border">
          {devices.map((device) => (
            <li key={device.id} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{device.name}</p>
                <p className="text-sm text-muted">
                  {device.branchName ? `${device.branchName} · ` : ""}
                  {device.lastSeenAt
                    ? t("lastSeen", { when: format.relativeTime(new Date(device.lastSeenAt)) })
                    : t("neverSeen")}
                </p>
              </div>
              {deviceStatus(device)}
              {device.status === "suspended" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    void run(() => api(`/api/v1/shop-devices/${device.id}/approve`, { method: "POST" }), t("approved"))
                  }
                >
                  {t("approve")}
                </Button>
              ) : null}
              {device.status !== "revoked" ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() =>
                    void run(() => api(`/api/v1/shop-devices/${device.id}/revoke`, { method: "POST" }), t("revoked"))
                  }
                >
                  {t("revoke")}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>

      {thisDeviceEnrolled ? (
        <Card className="space-y-3">
          <h2 className="text-lg font-semibold">{t("exitTitle")}</h2>
          <Button variant="outline" disabled={pending} onClick={() => void exitShopMode()}>
            {t("exit")}
          </Button>
        </Card>
      ) : (
        <Card className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold">{t("enableTitle")}</h2>
            <p className="text-sm text-muted">{t("enableLead")}</p>
          </div>
          <SafeForm className="grid gap-3 sm:grid-cols-2" pending={pending} onSubmit={enableShopMode}>
            <FormField id="device-name" label={t("deviceName")}>
              <Input id="device-name" name="deviceName" maxLength={80} placeholder={t("deviceNamePlaceholder")} required />
            </FormField>
            <FormField id="device-branch" label={t("shop")}>
              <Select id="device-branch" name="branchId">
                {branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <div className="sm:col-span-2">
              <SubmitButton pending={pending} pendingLabel={t("enabling")}>
                {t("enable")}
              </SubmitButton>
            </div>
          </SafeForm>
        </Card>
      )}
    </div>
  );
}
