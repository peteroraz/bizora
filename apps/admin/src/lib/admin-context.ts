"use client";

import { adminCan, type AdminAbility } from "@bizora/contracts";
import { createContext, useContext } from "react";
import type { AdminMe } from "./admin-api";

export const AdminContext = createContext<AdminMe | null>(null);

/** The signed-in staff member; only used on screens inside the portal shell. */
export function useAdmin() {
  const me = useContext(AdminContext);
  if (!me) throw new Error("useAdmin must be used inside AdminShell");
  return me;
}

export function useCan(ability: AdminAbility) {
  return adminCan(useAdmin().roles, ability);
}
