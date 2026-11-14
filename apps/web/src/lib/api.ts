export async function api(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...init, headers, credentials: "include" });
  if (response.status === 401 && typeof window !== "undefined") {
    window.location.href = "/login?reason=session";
  }
  return response;
}
