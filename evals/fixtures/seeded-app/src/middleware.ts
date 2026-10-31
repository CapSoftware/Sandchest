import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "./lib/session";

const PUBLIC_API = ["/api/auth/login", "/api/auth/reset", "/api/public/"];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_API.some((prefix) => pathname.startsWith(prefix))) return NextResponse.next();

  if (!request.cookies.has(SESSION_COOKIE)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Sign in required" }, { status: 401 });
    }
    const login = new URL("/login", request.url);
    login.searchParams.set("next", pathname);
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*", "/invoices/:path*", "/settings/:path*"],
};
