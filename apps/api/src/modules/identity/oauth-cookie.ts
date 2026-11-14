import { createHmac, timingSafeEqual } from "node:crypto";

export const OAUTH_COOKIE = "bizora_oauth";
export const OAUTH_TRANSACTION_TTL_MS = 10 * 60 * 1000;

export type OauthIntent = "login" | "link" | "invite";
export type OauthProviderName = "google" | "microsoft";

export type OauthTransaction = {
  provider: OauthProviderName;
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  intent: OauthIntent;
  iat: number;
  inviteToken?: string;
  userId?: string;
};

export function sealOauthTransaction(payload: Omit<OauthTransaction, "iat"> & { iat?: number }, secret: string): string {
  const issued: OauthTransaction = { ...payload, iat: payload.iat ?? Date.now() };
  const body = Buffer.from(JSON.stringify(issued), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function openOauthTransaction(token: string, secret: string): OauthTransaction | null {
  const split = token.lastIndexOf(".");
  if (split <= 0) return null;
  const body = token.slice(0, split);
  const signature = token.slice(split + 1);
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as OauthTransaction;
    if (!parsed.state || !parsed.nonce || !parsed.codeVerifier || !parsed.provider) return null;
    if (typeof parsed.iat !== "number" || !Number.isFinite(parsed.iat)) return null;
    if (Date.now() - parsed.iat > OAUTH_TRANSACTION_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}
