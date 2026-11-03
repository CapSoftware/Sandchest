import { NextResponse, type NextRequest } from "next/server";
import { CLAIM_COOKIE, CLAIM_COOKIE_MAX_AGE } from "@/lib/free-credits";

/**
 * "Claim 20 free credits": remembers that the person came to claim (through
 * signing in and installing on GitHub), then starts recruiting. Get started
 * signs them in first if they need it. The cookie only marks intent: who may
 * claim is decided on the server when they do.
 */
export function GET(request: NextRequest): NextResponse {
  const response = NextResponse.redirect(new URL("/get-started", request.url), 303);
  response.cookies.set(CLAIM_COOKIE, "1", { path: "/", maxAge: CLAIM_COOKIE_MAX_AGE, sameSite: "lax", httpOnly: true, secure: request.nextUrl.protocol === "https:" });
  response.headers.set("cache-control", "no-store");
  return response;
}
