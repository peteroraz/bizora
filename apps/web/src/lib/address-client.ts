import { api } from "./api";
import type { AddressValue } from "./reference";

export function addressPayload(value: AddressValue) {
  return {
    line1: value.line1.trim(),
    line2: value.line2.trim() || null,
    city: value.city.trim(),
    subdivisionCode: value.subdivisionCode.trim() || null,
    postalCode: value.postalCode.trim() || null,
    countryCode: value.countryCode,
  };
}

type AddressOwner = { kind: "organization" } | { kind: "business"; id: string } | { kind: "branch"; id: string };

export async function persistOwnerAddress(owner: AddressOwner, value: AddressValue) {
  const path =
    owner.kind === "organization"
      ? "/api/v1/organizations/current/address"
      : owner.kind === "business"
        ? `/api/v1/businesses/${owner.id}/address`
        : `/api/v1/branches/${owner.id}/address`;
  const response = await api(path, {
    method: "PUT",
    body: JSON.stringify(addressPayload(value)),
  });
  const payload = await response.json();
  if (!response.ok) {
    const fieldError = payload.error?.fieldErrors?.[0]?.message as string | undefined;
    throw new Error(fieldError ?? payload.error?.message ?? "Could not save the address.");
  }
}
