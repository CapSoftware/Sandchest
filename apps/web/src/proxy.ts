import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIES } from "./lib/app-routes";

/**
 * Sends signed-out visitors to sign in, remembering where they were going
 * (a Check's "Full details" link, an emailed finding). Only checks that a
 * session cookie exists; every page still verifies the session and access.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const hasSession = SESSION_COOKIES.some((name) => request.cookies.has(name));
  if (hasSession) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = "/sign-in";
  url.search = "";
  url.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.redirect(url);
}

/**
 * Only the dashboard runs the proxy (`:path*` also matches the bare section).
 * Everything else, the landing page, docs and legal pages above all, never
 * does: on Vercel they stay static and are served straight from the CDN, with
 * no function in front of them.
 */
export const config = { matcher: ["/dashboard/:path*"] };
