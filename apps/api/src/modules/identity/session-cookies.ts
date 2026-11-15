import { DEVICE_COOKIE, REFRESH_COOKIE, SESSION_COOKIE } from "@bizora/auth";
import type { AppEnv } from "@bizora/config/env";
import { ttlToMs } from "@bizora/config/env";
import type { CookieOptions, Response } from "express";
import type { AuthPayload } from "./identity.service.js";

export function writeSessionCookies(res: Response, env: AppEnv, accessToken: string, refreshToken: string) {
  res.cookie(SESSION_COOKIE, accessToken, cookieOptions(env, ttlToMs(env.JWT_ACCESS_TTL)));
  res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions(env, ttlToMs(env.JWT_REFRESH_TTL)));
}

export function clearSessionCookies(res: Response, env: AppEnv) {
  const base = cookieOptions(env, 0);
  res.clearCookie(SESSION_COOKIE, base);
  res.clearCookie(REFRESH_COOKIE, base);
}

export function applySession(res: Response, env: AppEnv, session: AuthPayload | null) {
  if (session?.accessToken && session.refreshToken) {
    writeSessionCookies(res, env, session.accessToken, session.refreshToken);
  }
}

function cookieOptions(env: AppEnv, maxAge: number): CookieOptions {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAMESITE,
    path: "/",
    maxAge,
  };
}

const DEVICE_COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

/** Long-lived httpOnly cookie that marks this browser as an enrolled shop device. */
export function writeDeviceCookie(res: Response, env: AppEnv, deviceToken: string) {
  res.cookie(DEVICE_COOKIE, deviceToken, cookieOptions(env, DEVICE_COOKIE_MAX_AGE_MS));
}

export function clearDeviceCookie(res: Response, env: AppEnv) {
  res.clearCookie(DEVICE_COOKIE, cookieOptions(env, 0));
}
