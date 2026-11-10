import { randomUUID } from "node:crypto";
import * as argon2 from "argon2";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import type { Role } from "@bizora/contracts";

export const SESSION_COOKIE = "bizora_session";

export type AccessTokenClaims = {
  sub: string;
  org: string;
  bid: string | null;
  br: string | null;
  mid: string;
  role: Role;
};

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password);
}

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signAccessToken(
  claims: AccessTokenClaims,
  secret: string,
  expiresIn: string,
): Promise<string> {
  return new SignJWT({
    org: claims.org,
    bid: claims.bid,
    br: claims.br,
    mid: claims.mid,
    role: claims.role,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setJti(randomUUID())
    .setExpirationTime(expiresIn)
    .sign(secretKey(secret));
}

export async function verifyAccessToken(
  token: string,
  secret: string,
): Promise<AccessTokenClaims> {
  const { payload } = await jwtVerify(token, secretKey(secret), {
    algorithms: ["HS256"],
  });
  return toClaims(payload);
}

function toClaims(payload: JWTPayload): AccessTokenClaims {
  if (typeof payload.sub !== "string") {
    throw new Error("Invalid token subject");
  }
  if (typeof payload.org !== "string" || typeof payload.mid !== "string") {
    throw new Error("Invalid tenant claims");
  }
  return {
    sub: payload.sub,
    org: payload.org,
    bid: typeof payload.bid === "string" ? payload.bid : null,
    br: typeof payload.br === "string" ? payload.br : null,
    mid: payload.mid,
    role: payload.role as Role,
  };
}

export function readBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}
