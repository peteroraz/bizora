"use client";

import { createContext, useContext } from "react";
import { noAccess, type Access } from "./access";

const AccessContext = createContext<Access>(noAccess);

export function AccessProvider({
  value,
  children,
}: {
  value: Access;
  children: React.ReactNode;
}) {
  return (
    <AccessContext.Provider value={value}>{children}</AccessContext.Provider>
  );
}

export function useAccess() {
  return useContext(AccessContext);
}

/**
 * The business's country, currency and time zone, for phone boxes, amount boxes and times. Falls back to Nigeria and naira only
 * before the business is known (sign-up); every signed-in screen has its own.
 */
export function usePlace() {
  const access = useContext(AccessContext);
  return {
    country: access.country ?? "NG",
    currency: access.currency ?? "NGN",
    timezone: access.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}
