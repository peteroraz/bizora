import { ApiError } from "../../common/errors.js";

function rejected(path: string): boolean {
  return (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    path.includes("://") ||
    path.includes("@") ||
    hasControl(path)
  );
}

function hasControl(path: string): boolean {
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

export function safeReturnTo(value: unknown): string {
  if (value === undefined || value === null || value === "") return "/app";
  if (typeof value !== "string" || value.length > 512) {
    throw new ApiError("REDIRECT_REJECTED", "That return path is not allowed.", 400);
  }
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
    const twice = decodeURIComponent(decoded);
    if (rejected(decoded) || rejected(twice) || /%(?:2f|5c)/i.test(decoded)) {
      throw new ApiError("REDIRECT_REJECTED", "That return path is not allowed.", 400);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("REDIRECT_REJECTED", "That return path is not allowed.", 400);
  }
  return decoded;
}

const tenantIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function microsoftIssuer(template: string, tid: unknown): string {
  if (typeof tid !== "string" || !tenantIdPattern.test(tid)) {
    throw new ApiError("OAUTH_REJECTED", "Sign-in could not be completed.", 400);
  }
  if (!template.includes("{tenantid}")) return template;
  return template.replaceAll("{tenantid}", tid);
}
