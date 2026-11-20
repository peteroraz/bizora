import type { AdminAbility, AdminRole } from "@bizora/contracts";

export type AdminMe = { email: string; name: string; roles: AdminRole[]; abilities: AdminAbility[] };

export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields: { field: string; message: string }[] = [],
  ) {
    super(message);
  }
}

/**
 * Calls the portal's API on this same address. Changes carry the portal's header, which other sites cannot send
 * without the API refusing them (ADR-037).
 */
export async function adminApi<T>(path: string, init: { method?: "GET" | "POST" | "PATCH"; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? "GET";
  const response = await fetch(`/api/admin/v1${path}`, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      accept: "application/json",
      ...(method === "GET" ? {} : { "content-type": "application/json", "x-bizora-admin": "1" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const payload = (await response.json().catch(() => null)) as
    | { data?: T; error?: { code?: string; message?: string; fieldErrors?: { field: string; message: string }[] } }
    | null;
  if (!response.ok) {
    throw new AdminApiError(response.status, payload?.error?.code ?? "UNKNOWN", payload?.error?.message ?? "", payload?.error?.fieldErrors ?? []);
  }
  return payload?.data as T;
}
