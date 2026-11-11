import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as argon2 from "argon2";
import { SignJWT, jwtVerify } from "jose";
import { accessTokenClaimsSchema, type AccessTokenClaims } from "@bizora/contracts";

export const SESSION_COOKIE = "bizora_session";
export const REFRESH_COOKIE = "bizora_refresh";

export type { AccessTokenClaims };

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function newRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signAccessToken(
  claims: AccessTokenClaims,
  secret: string,
  expiresIn: string | number,
): Promise<string> {
  const parsed = accessTokenClaimsSchema.parse(claims);
  return new SignJWT({
    sid: parsed.sid,
    typ: parsed.typ,
    org: parsed.org,
    bid: parsed.bid ?? null,
    br: parsed.br ?? null,
    mid: parsed.mid,
    role: parsed.role,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(parsed.sub)
    .setIssuedAt()
    .setJti(randomUUID())
    .setExpirationTime(expiresIn)
    .sign(secretKey(secret));
}

export async function verifyAccessToken(token: string, secret: string): Promise<AccessTokenClaims> {
  const { payload } = await jwtVerify(token, secretKey(secret), {
    algorithms: ["HS256"],
  });
  return accessTokenClaimsSchema.parse({
    sub: payload.sub,
    sid: payload.sid,
    typ: payload.typ,
    org: payload.org,
    mid: payload.mid,
    bid: payload.bid ?? null,
    br: payload.br ?? null,
    role: payload.role,
  });
}

export function readBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

export function readCookieValue(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const found = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return found ? found.slice(name.length + 1) : null;
}
