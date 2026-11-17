"use client";

import {
  ALWAYS_VISIBLE_MODULES,
  Permission,
  TRADER_MODULES,
  businessTypeSchema,
  staffCountBandSchema,
  type BusinessType,
  type StaffCountBand,
} from "@bizora/contracts";
import { Card, FormField, Input, PageHeader, SafeForm, Select, SubmitButton, Tab, TabPanel, TabsRoot, useTheme, type ThemeChoice } from "@bizora/ui";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useEffect, useState } from "react";
import { AddressFields } from "../../../components/address-fields";
import { SecurityPanel } from "../../../components/security-panel";
import { BrandSettings } from "../../../components/brand-settings";
import { can, settingsTabs as tabs, visibleSettingsTabs } from "../../../lib/access";
import { useAccess } from "../../../lib/access-context";
import { api } from "../../../lib/api";
import { hasPlace, persistOwnerAddress } from "../../../lib/address-client";
import { emptyAddress, type AddressValue, type CountryOption, type SubdivisionOption } from "../../../lib/reference";

type Person = { membershipId: string; email: string | null; displayName: string | null; role: string };
type Invitation = { id: string; email: string; role: string; status: string };
type Business = {
  id: string;
  name: string;
  countryCode: string;
  baseCurrencyCode: string;
  timezone: string;
  phoneE164: string | null;
  businessType: BusinessType | null;
  otherCurrencies: boolean;
  staffCountBand: StaffCountBand | null;
  branchCount: number | null;
  whatYouSell: string | null;
  staffFeaturesEnabled: boolean;
  visibleModules: string[];
  salesFlow?: "simple" | "desk";
};
type Branch = { id: string; name: string; phoneE164: string | null; address: AddressValue | null };
type BranchDraft = { name: string; phone: string; address: AddressValue };

const roles = ["ADMINISTRATOR", "MANAGER", "SALES", "CASHIER", "INVENTORY", "ACCOUNTANT", "EMPLOYEE", "AUDITOR"] as const;
const locales = ["en-NG", "pcm", "ha", "ig", "yo"] as const;

function fromAddress(address: Partial<AddressValue> | null, countryCode: string): AddressValue {
  const empty = emptyAddress(countryCode);
  if (!address) return empty;
  return {
    line1: address.line1 ?? "",
    line2: address.line2 ?? "",
    city: address.city ?? "",
    subdivisionCode: address.subdivisionCode ?? "",
    postalCode: address.postalCode ?? "",
    countryCode: address.countryCode || countryCode,
    marketOrPlaza: address.marketOrPlaza ?? "",
    lineOrBlock: address.lineOrBlock ?? "",
    shopNumber: address.shopNumber ?? "",
  };
}

function SettingsScreen() {
  const t = useTranslations("settings");
  const common = useTranslations("common");
  const nav = useTranslations("nav");
  const roleLabels = useTranslations("roles");
  const themeLabels = useTranslations("theme");
  const localeLabels = useTranslations("locales");
  const onboarding = useTranslations("onboarding");
  const locale = useLocale();
  const access = useAccess();
  const canSeePeople = can(access, Permission.USERS_READ);
  const canInvite = can(access, Permission.USERS_INVITE);
  const params = useSearchParams();
  const requested = params.get("tab") === "password" ? "security" : (params.get("tab") ?? "organization");
  const { theme, setTheme } = useTheme();
  const [tab, setTab] = useState(tabs.includes(requested as (typeof tabs)[number]) ? requested : "organization");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [countries, setCountries] = useState<CountryOption[]>([]);
  const [orgSubs, setOrgSubs] = useState<SubdivisionOption[]>([]);
  const [businessSubs, setBusinessSubs] = useState<SubdivisionOption[]>([]);
  const [orgName, setOrgName] = useState("");
  const [orgPhone, setOrgPhone] = useState("");
  const [orgAddress, setOrgAddress] = useState<AddressValue>(emptyAddress());
  const [business, setBusiness] = useState<Business | null>(null);
  const [businessAddress, setBusinessAddress] = useState<AddressValue>(emptyAddress());
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchDrafts, setBranchDrafts] = useState<Record<string, BranchDraft>>({});
  const [branchSubs, setBranchSubs] = useState<Record<string, SubdivisionOption[]>>({});
  const [people, setPeople] = useState<Person[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [businessType, setBusinessType] = useState<BusinessType>("shop");
  const [otherCurrencies, setOtherCurrencies] = useState(false);
  const [staffBand, setStaffBand] = useState<StaffCountBand>("1");
  const [branchCount, setBranchCount] = useState("1");
  const [whatYouSell, setWhatYouSell] = useState("");
  const [staffFeatures, setStaffFeatures] = useState(true);
  const [salesFlow, setSalesFlow] = useState<"simple" | "desk">("simple");
  // The desk flow needs three staff (sales person, cashier, store keeper); say so when the plan allows fewer (6d).
  const [staffLimit, setStaffLimit] = useState<number | null>(null);
  const [planName, setPlanName] = useState("");
  useEffect(() => {
    void api("/api/v1/plan")
      .then(async (response) => {
        if (!response.ok) return;
        const data = (await response.json()).data;
        setStaffLimit(typeof data?.limits?.max_staff === "number" ? data.limits.max_staff : null);
        setPlanName(data?.plan?.name ?? "");
      })
      .catch(() => undefined);
  }, []);
  const [savedFlow, setSavedFlow] = useState<"simple" | "desk">("simple");
  const [modules, setModules] = useState<string[]>([...TRADER_MODULES]);

  async function subdivisionsFor(code: string) {
    const response = await api(`/api/v1/reference/countries/${code}/subdivisions`);
    return response.ok ? ((await response.json()).data?.items ?? []) : [];
  }

  function shownError(caught: unknown) {
    if (caught instanceof Error && caught.message && caught.message !== "ADDRESS") return caught.message;
    return t("saveFailed");
  }

  async function refresh() {
    const [orgResponse, businessResponse, branchResponse, peopleResponse, inviteResponse, countryResponse] = await Promise.all([
      api("/api/v1/organizations/current"),
      api("/api/v1/businesses"),
      api("/api/v1/branches"),
      canSeePeople ? api("/api/v1/memberships") : Promise.resolve(null),
      canSeePeople ? api("/api/v1/invitations") : Promise.resolve(null),
      api("/api/v1/reference/countries"),
    ]);
    const organization = orgResponse.ok ? (await orgResponse.json()).data?.organization : null;
    setCountries(countryResponse.ok ? ((await countryResponse.json()).data?.items ?? []) : []);
    if (organization) {
      setOrgName(organization.name ?? "");
      setOrgPhone(organization.phoneE164 ?? "");
      const next = fromAddress(organization.address, organization.address?.countryCode ?? "NG");
      setOrgAddress(next);
      setOrgSubs(await subdivisionsFor(next.countryCode));
    }
    const businessItems = businessResponse.ok ? ((await businessResponse.json()).data?.items ?? []) : [];
    const current = businessItems[0]
      ? {
          ...businessItems[0],
          countryCode: String(businessItems[0].countryCode).trim(),
          baseCurrencyCode: String(businessItems[0].baseCurrencyCode).trim(),
          timezone: String(businessItems[0].timezone).trim(),
          visibleModules: (businessItems[0].visibleModules ?? TRADER_MODULES).map((item: string) => String(item).trim()),
        }
      : null;
    setBusiness(current);
    if (current) {
      const next = fromAddress(current.address, String(current.countryCode).trim());
      setBusinessAddress(next);
      setBusinessSubs(await subdivisionsFor(next.countryCode));
      setBusinessType(current.businessType ?? "shop");
      setOtherCurrencies(Boolean(current.otherCurrencies));
      setStaffBand(current.staffCountBand ?? "1");
      setBranchCount(String(current.branchCount ?? 1));
      setWhatYouSell(current.whatYouSell ?? "");
      setStaffFeatures(current.staffFeaturesEnabled !== false);
      setSalesFlow(current.salesFlow === "desk" ? "desk" : "simple");
      setSavedFlow(current.salesFlow === "desk" ? "desk" : "simple");
      setModules(current.visibleModules);
    }
    const loadedBranches: Branch[] = branchResponse.ok ? ((await branchResponse.json()).data?.items ?? []) : [];
    setBranches(loadedBranches);
    const drafts: Record<string, BranchDraft> = {};
    const subs: Record<string, SubdivisionOption[]> = {};
    for (const branch of loadedBranches) {
      const address = fromAddress(branch.address, branch.address?.countryCode ?? "NG");
      drafts[branch.id] = { name: branch.name, phone: branch.phoneE164 ?? "", address };
      subs[branch.id] = await subdivisionsFor(address.countryCode || "NG");
    }
    setBranchDrafts(drafts);
    setBranchSubs(subs);
    setPeople(peopleResponse?.ok ? ((await peopleResponse.json()).data?.items ?? []) : []);
    setInvitations(inviteResponse?.ok ? ((await inviteResponse.json()).data?.items ?? []) : []);
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function saveOrganization(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      if (hasPlace(orgAddress)) await persistOwnerAddress({ kind: "organization" }, orgAddress);
      const response = await api("/api/v1/organizations/current", {
        method: "PATCH",
        body: JSON.stringify({ name: orgName, phoneE164: orgPhone || null }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message ?? t("saveFailed"));
      setNotice(t("savedBusiness"));
      await refresh();
    } catch (caught) {
      setError(shownError(caught));
    } finally {
      setPending(false);
    }
  }

  async function saveBusiness(event: FormEvent) {
    event.preventDefault();
    if (!business) return;
    setPending(true);
    setError(null);
    try {
      if (hasPlace(businessAddress)) await persistOwnerAddress({ kind: "business", id: business.id }, businessAddress);
      const response = await api(`/api/v1/businesses/${business.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: business.name,
          countryCode: businessAddress.countryCode,
          baseCurrencyCode: business.baseCurrencyCode,
          timezone: business.timezone,
          phoneE164: business.phoneE164 || null,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.fieldErrors?.[0]?.message ?? payload.error?.message ?? t("saveFailed"));
      setNotice(t("savedShop"));
      await refresh();
    } catch (caught) {
      setError(shownError(caught));
    } finally {
      setPending(false);
    }
  }

  async function saveSetup() {
    if (!business) return;
    setPending(true);
    setError(null);
    const visible = TRADER_MODULES.filter((item) => ALWAYS_VISIBLE_MODULES.includes(item) || (modules.includes(item) && (item !== "staff" || staffFeatures)));
    try {
      const response = await api(`/api/v1/businesses/${business.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          businessType,
          otherCurrencies,
          multiCurrencyEnabled: otherCurrencies,
          staffCountBand: staffBand,
          branchCount: Number(branchCount) || 1,
          whatYouSell: whatYouSell.trim() || null,
          staffFeaturesEnabled: staffFeatures,
          visibleModules: visible,
          salesFlow,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message ?? t("saveFailed"));
      // Menus and screens change with the way of selling, so load the app again.
      if (salesFlow !== savedFlow) {
        window.location.reload();
        return;
      }
      setNotice(t("savedSetup"));
      await refresh();
    } catch (caught) {
      setError(shownError(caught));
    } finally {
      setPending(false);
    }
  }

  async function saveBranch(branchId: string) {
    const draft = branchDrafts[branchId];
    if (!draft) return;
    setPending(true);
    setError(null);
    try {
      if (hasPlace(draft.address)) await persistOwnerAddress({ kind: "branch", id: branchId }, draft.address);
      const response = await api(`/api/v1/branches/${branchId}`, {
        method: "PATCH",
        body: JSON.stringify({ name: draft.name, phoneE164: draft.phone || null }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message ?? t("branchFailed"));
      setNotice(t("branchSaved"));
      await refresh();
    } catch (caught) {
      setError(shownError(caught));
    } finally {
      setPending(false);
    }
  }

  function updateBranchDraft(branchId: string, patch: Partial<BranchDraft>) {
    setBranchDrafts((current) => {
      const draft = current[branchId];
      if (!draft) return current;
      return { ...current, [branchId]: { ...draft, ...patch } };
    });
  }

  async function createBranch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!business) return;
    const form = event.currentTarget;
    setPending(true);
    const response = await api("/api/v1/branches", {
      method: "POST",
      body: JSON.stringify({ name: new FormData(form).get("name"), businessId: business.id }),
    });
    const payload = await response.json();
    setPending(false);
    if (!response.ok) {
      setError(payload.error?.message ?? t("branchCreateFailed"));
      return;
    }
    form.reset();
    await refresh();
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setPending(true);
    const response = await api("/api/v1/invitations", {
      method: "POST",
      body: JSON.stringify({ email: new FormData(form).get("email"), role: new FormData(form).get("role") }),
    });
    const payload = await response.json();
    setPending(false);
    if (!response.ok) {
      setError(payload.error?.message ?? t("inviteFailed"));
      return;
    }
    setNotice(payload.data?.invitation?.inviteUrl ? t("inviteLink", { url: payload.data.invitation.inviteUrl }) : t("inviteSent"));
    form.reset();
    await refresh();
  }

  async function invitationAction(id: string, action: "resend" | "revoke") {
    const response = await api(`/api/v1/invitations/${id}/${action}`, { method: "POST" });
    const payload = await response.json();
    if (!response.ok) {
      setError(t("actionFailed"));
      return;
    }
    if (action === "resend" && payload.data?.invitation?.inviteUrl) setNotice(t("inviteLink", { url: payload.data.invitation.inviteUrl }));
    await refresh();
  }

  function statusLabel(status: string) {
    if (status === "PENDING" || status === "ACCEPTED" || status === "REVOKED") return t(`status.${status}`);
    return status;
  }

  function roleLabel(role: string) {
    return roleLabels.has(role) ? roleLabels(role) : role;
  }

  const zones = countries.find((item) => item.code === businessAddress.countryCode)?.timezones ?? [];
  const visibleTabs: string[] = visibleSettingsTabs(access, staffFeatures);
  const typeKey = {
    shop: "typeShop",
    "market-stall": "typeMarket",
    wholesale: "typeWholesale",
    pharmacy: "typePharmacy",
    fashion: "typeFashion",
    electronics: "typeElectronics",
    building: "typeBuilding",
    food: "typeFood",
    services: "typeServices",
    other: "typeOther",
  } as const;
  const bandKey = { "1": "staff1", "2-5": "staff2", "6-20": "staff6", "21+": "staff21" } as const;

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} intro={t("description")} />
      {error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p className="break-all text-sm text-muted">{notice}</p> : null}
      <TabsRoot
        value={visibleTabs.includes(tab) ? tab : (visibleTabs[0] ?? "appearance")}
        onValueChange={setTab}
        label={t("tabsLabel")}
        tabs={visibleTabs.map((item) => (
          <Tab key={item} value={item}>
            {t(`tabs.${item}`)}
          </Tab>
        ))}
      >
        <TabPanel value="organization">
          <Card>
            <SafeForm className="space-y-4" pending={pending} onSubmit={saveOrganization}>
              <FormField id="org-name" label={t("businessName")}>
                <Input id="org-name" value={orgName} onChange={(event) => setOrgName(event.target.value)} required />
              </FormField>
              <AddressFields
                idPrefix="org"
                countries={countries}
                subdivisions={orgSubs}
                value={orgAddress}
                onChange={(next) => {
                  setOrgAddress(next);
                  if (next.countryCode !== orgAddress.countryCode) void subdivisionsFor(next.countryCode).then(setOrgSubs);
                }}
              />
              <FormField id="org-phone" label={common("phone")}>
                <Input id="org-phone" value={orgPhone} onChange={(event) => setOrgPhone(event.target.value)} placeholder={t("phonePlaceholder")} />
              </FormField>
              <SubmitButton pending={pending} pendingLabel={common("saving")}>
                {t("saveBusiness")}
              </SubmitButton>
            </SafeForm>
          </Card>
        </TabPanel>
        <TabPanel value="brand">
          <BrandSettings />
        </TabPanel>
        <TabPanel value="business">
          <Card>
            {business ? (
              <SafeForm className="space-y-4" pending={pending} onSubmit={saveBusiness}>
                <FormField id="business-name" label={t("shopName")}>
                  <Input id="business-name" value={business.name} onChange={(event) => setBusiness({ ...business, name: event.target.value })} required />
                </FormField>
                <AddressFields
                  idPrefix="business"
                  countries={countries}
                  subdivisions={businessSubs}
                  value={businessAddress}
                  onChange={(next) => {
                    const country = countries.find((item) => item.code === next.countryCode);
                    setBusinessAddress(next);
                    if (next.countryCode !== businessAddress.countryCode && country) {
                      void subdivisionsFor(next.countryCode).then(setBusinessSubs);
                      setBusiness({
                        ...business,
                        baseCurrencyCode: country.defaultCurrencyCode,
                        timezone: country.timezones[0] ?? business.timezone,
                      });
                    }
                  }}
                />
                <FormField id="business-currency" label={common("currency")}>
                  <Input
                    id="business-currency"
                    value={business.baseCurrencyCode}
                    maxLength={3}
                    onChange={(event) => setBusiness({ ...business, baseCurrencyCode: event.target.value.toUpperCase() })}
                  />
                </FormField>
                <FormField id="business-timezone" label={common("timezone")}>
                  <Select id="business-timezone" value={business.timezone} onChange={(event) => setBusiness({ ...business, timezone: event.target.value })}>
                    {(zones.length > 0 ? zones : [business.timezone]).map((zone) => (
                      <option key={zone} value={zone}>
                        {zone}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <FormField id="business-phone" label={common("phone")}>
                  <Input
                    id="business-phone"
                    value={business.phoneE164 ?? ""}
                    onChange={(event) => setBusiness({ ...business, phoneE164: event.target.value })}
                    placeholder={t("phonePlaceholder")}
                  />
                </FormField>
                <SubmitButton pending={pending} pendingLabel={common("saving")}>
                  {t("saveShop")}
                </SubmitButton>
              </SafeForm>
            ) : (
              <p className="text-sm text-muted">{t("noBusiness")}</p>
            )}
          </Card>
        </TabPanel>
        <TabPanel value="shop">
          <Card>
            <SafeForm className="space-y-4" pending={pending} onSubmit={saveSetup}>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">{t("businessType")}</legend>
                {businessTypeSchema.options.map((type) => (
                  <label key={type} className="flex items-center gap-2 text-sm">
                    <input type="radio" name="setup-type" checked={businessType === type} onChange={() => setBusinessType(type)} />
                    {onboarding(typeKey[type])}
                  </label>
                ))}
              </fieldset>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">{t("staffCount")}</legend>
                {staffCountBandSchema.options.map((band) => (
                  <label key={band} className="flex items-center gap-2 text-sm">
                    <input type="radio" name="setup-staff" checked={staffBand === band} onChange={() => setStaffBand(band)} />
                    {onboarding(bandKey[band])}
                  </label>
                ))}
              </fieldset>
              <FormField id="setup-shops" label={t("branchCount")}>
                <Input id="setup-shops" inputMode="numeric" value={branchCount} onChange={(event) => setBranchCount(event.target.value)} />
              </FormField>
              <FormField id="setup-sell" label={t("whatYouSell")} hint={common("optional")}>
                <Input id="setup-sell" value={whatYouSell} onChange={(event) => setWhatYouSell(event.target.value)} />
              </FormField>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={otherCurrencies} onChange={(event) => setOtherCurrencies(event.target.checked)} />
                {t("otherCurrencies")}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={staffFeatures} onChange={(event) => setStaffFeatures(event.target.checked)} />
                {t("staffFeatures")}
              </label>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">{t("salesFlow")}</legend>
                {(["simple", "desk"] as const).map((option) => (
                  <label key={option} className="flex items-start gap-2 text-sm">
                    <input type="radio" name="setup-sales-flow" className="mt-1" checked={salesFlow === option} onChange={() => setSalesFlow(option)} />
                    <span>
                      <span className="block font-medium">{t(`salesFlowOption.${option}`)}</span>
                      <span className="block text-muted">{t(`salesFlowHint.${option}`)}</span>
                    </span>
                  </label>
                ))}
                {staffLimit !== null && staffLimit < 3 ? (
                  <p className="rounded-card border border-warning bg-warning-bg px-3 py-2 text-sm text-warning" data-testid="desk-plan-note">
                    {t("deskNeedsStaff", { plan: planName, limit: staffLimit })}
                  </p>
                ) : null}
              </fieldset>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">{t("modules")}</legend>
                {TRADER_MODULES.map((item) => {
                  const locked = ALWAYS_VISIBLE_MODULES.includes(item);
                  return (
                    <label key={item} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={locked || modules.includes(item)}
                        disabled={locked}
                        onChange={(event) => {
                          setModules((current) =>
                            event.target.checked ? [...current, item] : current.filter((module) => module !== item),
                          );
                        }}
                      />
                      {nav(item)}
                    </label>
                  );
                })}
              </fieldset>
              <SubmitButton pending={pending} pendingLabel={common("saving")}>
                {common("save")}
              </SubmitButton>
            </SafeForm>
          </Card>
        </TabPanel>
        <TabPanel value="branches">
          <div className="space-y-4">
            {branches.map((branch) => {
              const draft = branchDrafts[branch.id];
              if (!draft) return null;
              return (
                <Card key={branch.id}>
                  <SafeForm className="space-y-4" pending={pending} onSubmit={() => saveBranch(branch.id)}>
                    <FormField id={`branch-name-${branch.id}`} label={t("branch")}>
                      <Input
                        id={`branch-name-${branch.id}`}
                        value={draft.name}
                        onChange={(event) => updateBranchDraft(branch.id, { name: event.target.value })}
                        required
                      />
                    </FormField>
                    <AddressFields
                      idPrefix={`branch-${branch.id}`}
                      countries={countries}
                      subdivisions={branchSubs[branch.id] ?? []}
                      value={draft.address}
                      onChange={(next) => {
                        updateBranchDraft(branch.id, { address: next });
                        if (next.countryCode !== draft.address.countryCode) {
                          void subdivisionsFor(next.countryCode).then((items) =>
                            setBranchSubs((current) => ({ ...current, [branch.id]: items })),
                          );
                        }
                      }}
                    />
                    <FormField id={`branch-phone-${branch.id}`} label={common("phone")}>
                      <Input
                        id={`branch-phone-${branch.id}`}
                        value={draft.phone}
                        onChange={(event) => updateBranchDraft(branch.id, { phone: event.target.value })}
                      />
                    </FormField>
                    <SubmitButton pending={pending} pendingLabel={common("saving")}>
                      {common("save")}
                    </SubmitButton>
                  </SafeForm>
                </Card>
              );
            })}
            <Card>
              <SafeForm className="flex flex-wrap items-end gap-3" pending={pending} onSubmit={createBranch}>
                <FormField id="new-branch" label={t("newBranch")}>
                  <Input id="new-branch" name="name" required />
                </FormField>
                <SubmitButton pending={pending} pendingLabel={common("saving")}>
                  {t("addBranch")}
                </SubmitButton>
              </SafeForm>
            </Card>
          </div>
        </TabPanel>
        <TabPanel value="team">
          <Card className="space-y-4">
            <ul className="space-y-2 text-sm">
              {people.map((person) => (
                <li key={person.membershipId}>
                  {person.displayName}
                  {person.email ? ` (${person.email})` : ""} · {roleLabel(person.role)}
                </li>
              ))}
            </ul>
            {canInvite ? (
              <SafeForm className="grid gap-3 md:grid-cols-[1fr_180px_auto]" pending={pending} onSubmit={invite}>
                <Input name="email" type="email" aria-label={t("inviteEmail")} placeholder={t("invitePlaceholder")} required />
                <Select name="role" aria-label={t("inviteRole")} defaultValue="SALES">
                  {roles.map((role) => (
                    <option key={role} value={role}>
                      {roleLabel(role)}
                    </option>
                  ))}
                </Select>
                <SubmitButton pending={pending} pendingLabel={common("saving")}>
                  {t("invite")}
                </SubmitButton>
              </SafeForm>
            ) : null}
            <ul className="space-y-2 text-sm">
              {invitations.map((invitation) => (
                <li key={invitation.id} className="flex flex-wrap items-center gap-2">
                  <span>
                    {invitation.email} · {roleLabel(invitation.role)} · {statusLabel(invitation.status)}
                  </span>
                  {invitation.status === "PENDING" && canInvite ? (
                    <>
                      <button type="button" className="font-medium text-primary" onClick={() => void invitationAction(invitation.id, "resend")}>
                        {t("resend")}
                      </button>
                      <button type="button" className="font-medium text-muted" onClick={() => void invitationAction(invitation.id, "revoke")}>
                        {t("revoke")}
                      </button>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>
        </TabPanel>
        <TabPanel value="appearance">
          <Card className="space-y-3">
            <p className="text-sm text-muted">{t("appearanceLead")}</p>
            <div className="flex flex-wrap gap-2">
              {(["light", "dark", "system"] as ThemeChoice[]).map((choice) => (
                <button
                  key={choice}
                  type="button"
                  className={theme === choice ? "rounded-control bg-primary px-3 py-2 text-sm text-primary-fg" : "rounded-control border border-border px-3 py-2 text-sm"}
                  onClick={() => setTheme(choice)}
                >
                  {themeLabels(choice)}
                </button>
              ))}
            </div>
            <FormField id="language" label={t("language")}>
              <Select
                id="language"
                value={locale}
                onChange={(event) => {
                  document.cookie = `bizora_locale=${event.target.value}; Path=/; Max-Age=31536000; SameSite=Lax`;
                  window.location.reload();
                }}
              >
                {locales.map((item) => (
                  <option key={item} value={item}>
                    {localeLabels(item)}
                  </option>
                ))}
              </Select>
            </FormField>
          </Card>
        </TabPanel>
        <TabPanel value="security">
          <SecurityPanel />
        </TabPanel>
      </TabsRoot>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense>
      <SettingsScreen />
    </Suspense>
  );
}
