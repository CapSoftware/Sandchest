import { NextResponse, type NextRequest } from "next/server";

/**
 * Sends signed-out visitors to sign in, remembering where they were going
 * (a Check's "Full details" link, an emailed finding). Only checks that a
 * session cookie exists; every page still verifies the session and access.
 *
 * The operator dashboards answer at /admin, but no route is called that:
 * operators are rewritten to the internal `/ops` pages, and everyone else
 * falls through to the app's ordinary 404, the very response any unknown
 * path gets (body and headers), so nothing gives away that the page is there.
 * Asking for /ops directly gets the same 404 page.
 */
export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (path === "/admin" || path.startsWith("/admin/")) {
    // Loaded only here: the database client stays out of every other request's path.
    const { isOperatorSession } = await import("./server/operators");
    if (!(await isOperatorSession(request.cookies).catch(() => false))) return NextResponse.next();
    const url = request.nextUrl.clone();
    url.pathname = `/ops${path.slice("/admin".length)}`;
    return NextResponse.rewrite(url);
  }
  // The pages behind /admin, asked for by name: a 404 for everyone. (The rewrite above does not run the proxy again.)
  if (path === "/ops" || path.startsWith("/ops/")) return NextResponse.rewrite(new URL("/_not-found", request.url));
  const hasSession = request.cookies.has("better-auth.session_token") || request.cookies.has("__Secure-better-auth.session_token");
  if (hasSession) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = "/sign-in";
  url.search = "";
  url.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.redirect(url);
}

export const config = { matcher: ["/repos/:path*", "/findings/:path*", "/scans/:path*", "/settings/:path*", "/admin", "/admin/:path*", "/ops", "/ops/:path*"] };
