import type { ReactNode } from "react";
import { AuthProvidersProvider } from "../../components/auth-providers-context";
import { authProviders } from "../../lib/auth-providers";

// Sign-in options are read on the server and kept for five minutes, so the Google button comes with the page.
export const revalidate = 300;

export default async function Layout({ children }: { children: ReactNode }) {
  return <AuthProvidersProvider value={await authProviders()}>{children}</AuthProvidersProvider>;
}
