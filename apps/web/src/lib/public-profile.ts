/** A business's public page data (ADR-024), loaded on the server by its link name. */
export type PublicProfile = {
  name: string;
  handle: string;
  about: string | null;
  phone: string | null;
  address: string | null;
  color: string | null;
  hasLogo: boolean;
};

const origin = process.env.API_ORIGIN ?? "http://localhost:3001";
const HANDLE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,39}$/;

export async function loadProfile(handle: string): Promise<PublicProfile | null> {
  if (!HANDLE.test(handle)) return null;
  const response = await fetch(`${origin}/api/v1/public/profiles/${handle}`, { next: { revalidate: 60 } }).catch(() => null);
  if (!response?.ok) return null;
  return ((await response.json()) as { data: { profile: PublicProfile } }).data.profile;
}

/** The logo as a data address, for the share picture drawn on the server. */
export async function loadLogoDataUrl(handle: string): Promise<string | null> {
  const response = await fetch(`${origin}/api/v1/public/profiles/${handle}/logo`, { next: { revalidate: 300 } }).catch(() => null);
  if (!response?.ok) return null;
  const type = response.headers.get("content-type") ?? "image/png";
  if (type !== "image/png" && type !== "image/jpeg") return null;
  return `data:${type};base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`;
}
