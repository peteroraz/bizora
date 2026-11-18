const origin = process.env.API_ORIGIN ?? "http://localhost:3001";

export type AuthProviders = { google: boolean };

/**
 * Which sign-in providers are on, read on the server so the Google button arrives with the page instead of
 * appearing after the browser asks the API. Kept for five minutes. Null when the API cannot be reached (for example
 * while building); the button then asks from the browser as before.
 */
export async function authProviders(): Promise<AuthProviders | null> {
  // While the site is being built there is no API to ask; the first visit after that fills it in.
  if (process.env.NEXT_PHASE === "phase-production-build") return null;
  try {
    const response = await fetch(`${origin}/api/v1/auth/providers`, { next: { revalidate: 300 }, signal: AbortSignal.timeout(1500) });
    if (!response.ok) return null;
    const payload = (await response.json()) as { data?: AuthProviders };
    return payload.data ?? null;
  } catch {
    return null;
  }
}
