import { NextResponse, type NextRequest } from "next/server";
import { cookiePair, passNeedsRenewal, REFRESH_COOKIE, REFRESH_PATH, SESSION_COOKIE } from "./lib/session-pass";

const apiOrigin = process.env.API_ORIGIN ?? "http://localhost:3001";

/**
 * Opening or reloading an app page after the 15-minute pass ran out: renew it here, before the page asks the API
 * who is signed in, instead of sending a working person to the sign-in page (ADR-026).
 */
export async function middleware(request: NextRequest) {
  const refresh = request.cookies.get(REFRESH_COOKIE)?.value;
  if (!refresh || !passNeedsRenewal(request.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();

  let setCookies: string[] = [];
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
    if (!renewed.ok) return NextResponse.next();
    setCookies = renewed.headers.getSetCookie();
  } catch {
    // The API could not be reached; the page shows its own error or the sign-in page.
    return NextResponse.next();
  }

  // The page rendered for this request already sees the new pass; the browser keeps it for the next ones.
  for (const header of setCookies) {
    const pair = cookiePair(header);
    if (pair) request.cookies.set(pair[0], pair[1]);
  }
  const response = NextResponse.next({ request: { headers: request.headers } });
  for (const header of setCookies) response.headers.append("set-cookie", header);
  return response;
}

export const config = {
  matcher: ["/app/:path*", "/select-workspace"],
};
