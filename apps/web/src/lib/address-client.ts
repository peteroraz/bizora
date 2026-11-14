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

export async function persistAddress(value: AddressValue, existingId?: string | null) {
  const response = await api(existingId ? `/api/v1/addresses/${existingId}` : "/api/v1/addresses", {
    method: existingId ? "PATCH" : "POST",
    body: JSON.stringify(addressPayload(value)),
  });
  const payload = await response.json();
  if (!response.ok) {
    const fieldError = payload.error?.fieldErrors?.[0]?.message as string | undefined;
    throw new Error(fieldError ?? payload.error?.message ?? "Could not save the address.");
  }
  return payload.data.address.id as string;
}
