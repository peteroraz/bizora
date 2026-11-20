import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy, newNonce } from "./lib/csp";
import { cookiePair, passNeedsRenewal, REFRESH_COOKIE, REFRESH_PATH, SESSION_COOKIE } from "./lib/session-pass";

const apiOrigin = process.env.API_ORIGIN ?? "http://localhost:3001";
const RENEW_PATHS = /^\/(app(\/|$)|select-workspace$)/;

/**
 * Every page: a fresh nonce and the content security policy (ADR-036).
 * App pages: opening or reloading after the 15-minute pass ran out renews it here, before the page asks the API who
 * is signed in, instead of sending a working person to the sign-in page (ADR-026).
 */
export async function middleware(request: NextRequest) {
  const setCookies = RENEW_PATHS.test(request.nextUrl.pathname) ? await renewPass(request) : [];
  // The page rendered for this request already sees the new pass; the browser keeps it for the next ones.
  for (const header of setCookies) {
    const pair = cookiePair(header);
    if (pair) request.cookies.set(pair[0], pair[1]);
  }
  const nonce = newNonce();
  const https = (request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.replace(":", "")) === "https";
  const policy = contentSecurityPolicy(nonce, { https, development: process.env.NODE_ENV === "development" });
  const headers = new Headers(request.headers);
  // Next.js reads the nonce from this request header and puts it on its own scripts.
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", policy);
  for (const header of setCookies) response.headers.append("set-cookie", header);
  return response;
}

async function renewPass(request: NextRequest): Promise<string[]> {
  const refresh = request.cookies.get(REFRESH_COOKIE)?.value;
  if (!refresh || !passNeedsRenewal(request.cookies.get(SESSION_COOKIE)?.value)) return [];
  try {
    const renewed = await fetch(`${apiOrigin}${REFRESH_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: request.headers.get("cookie") ?? "",
        "user-agent": request.headers.get("user-agent") ?? "",
      },
      body: "{}",
      cache: "no-store",
    });
    return renewed.ok ? renewed.headers.getSetCookie() : [];
  } catch {
    // The API could not be reached; the page shows its own error or the sign-in page.
    return [];
  }
}

export const config = {
  matcher: [
    {
      // Pages only: not the API, Next.js files, or public files.
      source: "/((?!api/|_next/static|_next/image|health|ready|favicon.ico|icon.svg|sw.js|manifest.webmanifest|screens/|providers/).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
