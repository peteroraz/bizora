import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy, newNonce } from "./lib/csp";

export function middleware(request: NextRequest) {
  const nonce = newNonce();
  const https = (request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.replace(":", "")) === "https";
  const policy = contentSecurityPolicy(nonce, { https, development: process.env.NODE_ENV === "development" });
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  matcher: [{ source: "/((?!api/|_next/static|_next/image|health|favicon.ico|robots.txt).*)" }],
};
