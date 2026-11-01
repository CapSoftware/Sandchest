import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIES } from "./lib/app-routes";

/**
 * Sends signed-out visitors to sign in, remembering where they were going
 * (a Check's "Full details" link, an emailed finding). Only checks that a
 * session cookie exists; every page still verifies the session and access.
 *
 * The operator dashboards answer at /admin, but no route is called that:
 * operators are rewritten to the internal `/ops` pages, and everyone else
 * falls through to the app's ordinary 404, the very response any unknown
 * path gets (body and headers), so nothing gives away that the page is there.
 *
 * Asking for /ops by name is rewritten to a path no route can match, so it
 * gets the ordinary dynamic 404 too (same status, body and caching, for pages
 * and router requests alike). Next marks every rewrite with an
 * `x-middleware-rewrite` header (and `x-nextjs-rewritten-path` on router
 * requests) that a proxy cannot remove; nothing else differs. Perfect
 * parity is out of reach: the rewrite target must be a real route, which is
 * then reachable by name, and a proxy cannot replay the 404 itself because
 * Next hides the router's request headers from it.
 *
 * Paths are compared decoded and normalised (`/%61dmin`, `/admin%2fcost`
 * and `//admin/` are /admin), since that is how routes are matched.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const path = normalisePath(request.nextUrl.pathname);
  if (path === undefined) return NextResponse.next();
  const section = sectionOf(path);
  if (section === "admin") {
    // Loaded only here: the database client stays out of every other request's path.
    const { isOperatorSession } = await import("./server/operators");
    if (!(await isOperatorSession(request.cookies).catch(() => false))) return NextResponse.next();
    const url = request.nextUrl.clone();
    url.pathname = `/ops${path.slice("/admin".length)}`;
    return NextResponse.rewrite(url);
  }
  // The pages behind /admin, asked for by name. (The rewrite above does not run the proxy again.)
  // A leading underscore marks a private folder, so no route can ever answer here.
  if (section === "ops") return NextResponse.rewrite(new URL(NO_ROUTE, request.url));
  if (section === "dashboard") {
    const hasSession = SESSION_COOKIES.some((name) => request.cookies.has(name));
    if (hasSession) return NextResponse.next();
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    url.search = "";
    url.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

/**
 * Only the sections the proxy acts on, named one by one (`:path*` also
 * matches the bare section). Everything else, the landing page, docs and
 * legal pages above all, never runs the proxy: on Vercel they stay static
 * and are served straight from the CDN, with no function in front of them.
 * Next publishes these matchers to every visitor, so /admin and /ops are
 * visible here; that is accepted, since both are in the public source and
 * neither answers anyone but an operator.
 */
export const config = { matcher: ["/dashboard/:path*", "/admin/:path*", "/ops/:path*"] };

/** The path as routes see it: percent-decoded, repeated and trailing slashes removed. Undefined if it does not decode. */
export function normalisePath(pathname: string): string | undefined {
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  path = path.replace(/\/{2,}/g, "/");
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

const within = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/** Which part of the app a normalised path belongs to. */
export function sectionOf(path: string): "admin" | "ops" | "dashboard" | undefined {
  if (within(path, "/admin")) return "admin";
  if (within(path, "/ops")) return "ops";
  return within(path, "/dashboard") ? "dashboard" : undefined;
}

/** Where /ops asked for by name is sent: under a private folder (leading underscore), so never a route. */
const NO_ROUTE = "/_none";
