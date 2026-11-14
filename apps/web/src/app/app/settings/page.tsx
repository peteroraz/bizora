"use client";

import { Button, Card, FormField, Input, PageHeader, Select, Tab, TabPanel, TabsRoot, useTheme, type ThemeChoice } from "@bizora/ui";
import { useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useEffect, useState } from "react";
import { AddressFields } from "../../../components/address-fields";
import { ChangePasswordForm } from "../../../components/change-password-form";
import { api } from "../../../lib/api";
import { persistOwnerAddress } from "../../../lib/address-client";
import { emptyAddress, type AddressValue, type CountryOption, type SubdivisionOption } from "../../../lib/reference";

type Person = { membershipId: string; email: string | null; displayName: string | null; role: string };
type Invitation = { id: string; email: string; role: string; status: string };
type Business = {
  id: string;
  name: string;
  countryCode: string;
  baseCurrencyCode: string;
  timezone: string;
  industryCode: string | null;
  phoneE164: string | null;
  address: AddressValue | null;
};
type Branch = { id: string; name: string; phoneE164: string | null; address: AddressValue | null };
type BranchDraft = { name: string; phone: string; address: AddressValue };

const roles = ["ADMINISTRATOR", "MANAGER", "SALES", "CASHIER", "INVENTORY", "ACCOUNTANT", "EMPLOYEE", "AUDITOR"];
const tabs = ["organization", "business", "branches", "team", "appearance", "password"];

function fromAddress(address: AddressValue | null, countryCode: string): AddressValue {
  if (!address) return emptyAddress(countryCode);
  return {
    line1: address.line1 ?? "",
    line2: address.line2 ?? "",
    city: address.city ?? "",
    subdivisionCode: address.subdivisionCode ?? "",
    postalCode: address.postalCode ?? "",
    countryCode: address.countryCode || countryCode,
  };
}

function SettingsScreen() {
  const params = useSearchParams();
  const requested = params.get("tab") ?? "organization";
  const { theme, setTheme } = useTheme();
  const [tab, setTab] = useState(tabs.includes(requested) ? requested : "organization");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
  const [industries, setIndustries] = useState<{ code: string; name: string }[]>([]);

  async function subdivisionsFor(code: string) {
    const response = await api(`/api/v1/reference/countries/${code}/subdivisions`);
    return response.ok ? ((await response.json()).data?.items ?? []) : [];
  }

  async function refresh() {
    const [orgResponse, businessResponse, branchResponse, peopleResponse, inviteResponse, countryResponse, industryResponse] =
      await Promise.all([
        api("/api/v1/organizations/current"),
        api("/api/v1/businesses"),
        api("/api/v1/branches"),
        api("/api/v1/memberships"),
        api("/api/v1/invitations"),
        api("/api/v1/reference/countries"),
        fetch("/api/v1/catalogs/industry-packs").then((response) => response.json()),
      ]);
    const organization = orgResponse.ok ? (await orgResponse.json()).data?.organization : null;
    const loadedCountries = countryResponse.ok ? ((await countryResponse.json()).data?.items ?? []) : [];
    setCountries(loadedCountries);
    setIndustries(industryResponse.data?.items ?? []);
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
        }
      : null;
    setBusiness(current);
    if (current) {
      const next = fromAddress(current.address, String(current.countryCode).trim());
      setBusinessAddress(next);
      setBusinessSubs(await subdivisionsFor(next.countryCode));
    }
    const loadedBranches: Branch[] = branchResponse.ok ? ((await branchResponse.json()).data?.items ?? []) : [];
    setBranches(loadedBranches);
    const drafts: Record<string, BranchDraft> = {};
    const subs: Record<string, SubdivisionOption[]> = {};
    for (const branch of loadedBranches) {
      const address = fromAddress(branch.address, branch.address?.countryCode ?? "NG");
      drafts[branch.id] = {
        name: branch.name,
        phone: branch.phoneE164 ?? "",
        address,
      };
      subs[branch.id] = await subdivisionsFor(address.countryCode || "NG");
    }
    setBranchDrafts(drafts);
    setBranchSubs(subs);
    setPeople(peopleResponse.ok ? ((await peopleResponse.json()).data?.items ?? []) : []);
    setInvitations(inviteResponse.ok ? ((await inviteResponse.json()).data?.items ?? []) : []);
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function saveOrganization(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      if (orgAddress.line1.trim()) await persistOwnerAddress({ kind: "organization" }, orgAddress);
      const response = await api("/api/v1/organizations/current", {
        method: "PATCH",
        body: JSON.stringify({ name: orgName, phoneE164: orgPhone || null }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message ?? "Could not save the organization.");
      setNotice("Organization saved.");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the organization.");
    }
  }

  async function saveBusiness(event: FormEvent) {
    event.preventDefault();
    if (!business) return;
    setError(null);
    try {
      if (businessAddress.line1.trim()) {
        await persistOwnerAddress({ kind: "business", id: business.id }, businessAddress);
      }
      const response = await api(`/api/v1/businesses/${business.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: business.name,
          countryCode: businessAddress.countryCode,
          baseCurrencyCode: business.baseCurrencyCode,
          timezone: business.timezone,
          industryCode: business.industryCode,
          phoneE164: business.phoneE164 || null,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.fieldErrors?.[0]?.message ?? payload.error?.message ?? "Could not save the business.");
      setNotice("Business saved.");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the business.");
    }
  }

  async function saveBranch(branchId: string) {
    const draft = branchDrafts[branchId];
    if (!draft) return;
    setError(null);
    try {
      if (draft.address.line1.trim()) await persistOwnerAddress({ kind: "branch", id: branchId }, draft.address);
      const response = await api(`/api/v1/branches/${branchId}`, {
        method: "PATCH",
        body: JSON.stringify({ name: draft.name, phoneE164: draft.phone || null }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message ?? "Could not save the branch.");
      setNotice("Branch saved.");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the branch.");
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
    const form = new FormData(event.currentTarget);
    const response = await api("/api/v1/branches", {
      method: "POST",
      body: JSON.stringify({ name: form.get("name"), businessId: business.id }),
    });
    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error?.message ?? "Could not create the branch.");
      return;
    }
    event.currentTarget.reset();
    await refresh();
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const response = await api("/api/v1/invitations", {
      method: "POST",
      body: JSON.stringify({ email: form.get("email"), role: form.get("role") }),
    });
    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error?.message ?? "Could not send the invitation.");
      return;
    }
    setNotice(payload.data?.invitation?.inviteUrl ? `Invite link: ${payload.data.invitation.inviteUrl}` : "Invitation sent.");
    event.currentTarget.reset();
    await refresh();
  }

  async function invitationAction(id: string, action: "resend" | "revoke") {
    const response = await api(`/api/v1/invitations/${id}/${action}`, { method: "POST" });
    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error?.message ?? `Could not ${action} the invitation.`);
      return;
    }
    if (action === "resend" && payload.data?.invitation?.inviteUrl) setNotice(`Invite link: ${payload.data.invitation.inviteUrl}`);
    await refresh();
  }

  const zones = countries.find((item) => item.code === businessAddress.countryCode)?.timezones ?? [];

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Organization, locations, team, appearance, and password." />
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {notice ? <p className="break-all text-sm text-muted">{notice}</p> : null}
      <TabsRoot value={tab} onValueChange={setTab} label="Settings" tabs={tabs.map((item) => <Tab key={item} value={item}>{item[0]?.toUpperCase()}{item.slice(1)}</Tab>)}>
        <TabPanel value="organization">
          <Card>
            <form className="space-y-4" onSubmit={(event) => void saveOrganization(event)}>
              <FormField id="org-name" label="Organization name">
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
              <FormField id="org-phone" label="Phone">
                <Input id="org-phone" value={orgPhone} onChange={(event) => setOrgPhone(event.target.value)} placeholder="+2348012345678" />
              </FormField>
              <Button type="submit">Save organization</Button>
            </form>
          </Card>
        </TabPanel>
        <TabPanel value="business">
          <Card>
            {business ? (
              <form className="space-y-4" onSubmit={(event) => void saveBusiness(event)}>
                <FormField id="business-name" label="Trading name">
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
                    if (next.countryCode !== businessAddress.countryCode) {
                      void subdivisionsFor(next.countryCode).then(setBusinessSubs);
                      if (country) {
                        setBusiness({
                          ...business,
                          baseCurrencyCode: country.defaultCurrencyCode,
                          timezone: country.timezones[0] ?? business.timezone,
                        });
                      }
                    }
                  }}
                />
                <FormField id="business-currency" label="Currency">
                  <Input id="business-currency" value={business.baseCurrencyCode} maxLength={3} onChange={(event) => setBusiness({ ...business, baseCurrencyCode: event.target.value.toUpperCase() })} />
                </FormField>
                <FormField id="business-timezone" label="Timezone">
                  <Select id="business-timezone" value={business.timezone} onChange={(event) => setBusiness({ ...business, timezone: event.target.value })}>
                    {(zones.length > 0 ? zones : [business.timezone]).map((zone) => (
                      <option key={zone} value={zone}>{zone}</option>
                    ))}
                  </Select>
                </FormField>
                <FormField id="business-industry" label="Industry">
                  <Select id="business-industry" value={business.industryCode ?? ""} onChange={(event) => setBusiness({ ...business, industryCode: event.target.value })}>
                    {industries.map((item) => (
                      <option key={item.code} value={item.code}>{item.name}</option>
                    ))}
                  </Select>
                </FormField>
                <FormField id="business-phone" label="Phone">
                  <Input id="business-phone" value={business.phoneE164 ?? ""} onChange={(event) => setBusiness({ ...business, phoneE164: event.target.value })} placeholder="+2348012345678" />
                </FormField>
                <Button type="submit">Save business</Button>
              </form>
            ) : (
              <p className="text-sm text-muted">No business is available in this workspace.</p>
            )}
          </Card>
        </TabPanel>
        <TabPanel value="branches">
          <div className="space-y-4">
            {branches.map((branch) => {
              const draft = branchDrafts[branch.id];
              if (!draft) return null;
              return (
                <Card key={branch.id}>
                  <form
                    className="space-y-4"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void saveBranch(branch.id);
                    }}
                  >
                    <FormField id={`branch-name-${branch.id}`} label="Branch">
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
                    <FormField id={`branch-phone-${branch.id}`} label="Phone">
                      <Input
                        id={`branch-phone-${branch.id}`}
                        value={draft.phone}
                        onChange={(event) => updateBranchDraft(branch.id, { phone: event.target.value })}
                      />
                    </FormField>
                    <Button type="submit">Save</Button>
                  </form>
                </Card>
              );
            })}
            <Card>
              <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => void createBranch(event)}>
                <FormField id="new-branch" label="New branch">
                  <Input id="new-branch" name="name" required />
                </FormField>
                <Button type="submit">Add branch</Button>
              </form>
            </Card>
          </div>
        </TabPanel>
        <TabPanel value="team">
          <Card className="space-y-4">
            <ul className="space-y-2 text-sm">
              {people.map((person) => (
                <li key={person.membershipId}>
                  {person.displayName} ({person.email}) — {person.role}
                </li>
              ))}
            </ul>
            <form className="grid gap-3 md:grid-cols-[1fr_180px_auto]" onSubmit={(event) => void invite(event)}>
              <Input name="email" type="email" aria-label="Email" placeholder="teammate@business.com" required />
              <Select name="role" aria-label="Role" defaultValue="SALES">
                {roles.map((role) => (
                  <option key={role} value={role}>{role}</option>
                ))}
              </Select>
              <Button type="submit">Invite</Button>
            </form>
            <ul className="space-y-2 text-sm">
              {invitations.map((invitation) => (
                <li key={invitation.id} className="flex flex-wrap items-center gap-2">
                  <span>{invitation.email} — {invitation.role} — {invitation.status}</span>
                  {invitation.status === "PENDING" ? (
                    <>
                      <Button type="button" variant="secondary" size="sm" onClick={() => void invitationAction(invitation.id, "resend")}>Resend</Button>
                      <Button type="button" variant="ghost" size="sm" onClick={() => void invitationAction(invitation.id, "revoke")}>Revoke</Button>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>
        </TabPanel>
        <TabPanel value="appearance">
          <Card className="space-y-3">
            <p className="text-sm text-muted">Choose a theme. The choice is saved on this device and applied before the next page paints.</p>
            <div className="flex flex-wrap gap-2">
              {(["light", "dark", "system"] as ThemeChoice[]).map((choice) => (
                <Button key={choice} type="button" variant={theme === choice ? "primary" : "secondary"} onClick={() => setTheme(choice)}>
                  {choice[0]?.toUpperCase()}
                  {choice.slice(1)}
                </Button>
              ))}
            </div>
          </Card>
        </TabPanel>
        <TabPanel value="password">
          <ChangePasswordForm />
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
