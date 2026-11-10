export const TENANT_A_EMAIL = "alice@tenant-a.test";
export const TENANT_B_EMAIL = "bob@tenant-b.test";
export const SEED_PASSWORD = "LocalOnly!Passw0rd";

export function jsonHeaders(token?: string, extra?: Record<string, string>) {
  return {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}
