"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { AuthProviders } from "../lib/auth-providers";

const AuthProvidersContext = createContext<AuthProviders | null>(null);

/** Hands the sign-in providers read on the server to the sign-in buttons. */
export function AuthProvidersProvider({ value, children }: { value: AuthProviders | null; children: ReactNode }) {
  return <AuthProvidersContext.Provider value={value}>{children}</AuthProvidersContext.Provider>;
}

export function useAuthProviders() {
  return useContext(AuthProvidersContext);
}
