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
