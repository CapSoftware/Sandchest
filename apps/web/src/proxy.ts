import { NextResponse, type NextRequest } from "next/server";

/**
 * Sends signed-out visitors to sign in, remembering where they were going
 * (a Check's "Full details" link, an emailed finding). Only checks that a
 * session cookie exists; every page still verifies the session and access.
 */
export function proxy(request: NextRequest) {
  const hasSession = request.cookies.has("better-auth.session_token") || request.cookies.has("__Secure-better-auth.session_token");
  if (hasSession) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = "/sign-in";
  url.search = "";
  url.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.redirect(url);
}

export const config = { matcher: ["/repos/:path*", "/findings/:path*", "/scans/:path*", "/settings/:path*"] };
