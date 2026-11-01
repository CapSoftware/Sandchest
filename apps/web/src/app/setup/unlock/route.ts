/**
 * Opens setup for this browser: the link printed at boot (GET) or the token
 * pasted into the setup page (POST). The token becomes an hour-long cookie,
 * and the address bar loses it straight away.
 */
import { appUrl, SETUP_COOKIE, sessionValue, setupNeeded, setupOrigin, tokenMatches } from "@/server/setup";

export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  return unlock(request, new URL(request.url).searchParams.get("token"));
}

export async function POST(request: Request): Promise<Response> {
  const form = await request.formData().catch(() => undefined);
  const token = form?.get("token");
  return unlock(request, typeof token === "string" ? token : null);
}

function unlock(request: Request, token: string | null): Response {
  if (!setupNeeded()) return new Response("Not found", { status: 404 });
  const headers = new Headers({ location: "/setup", "cache-control": "no-store", "referrer-policy": "no-referrer" });
  if (!tokenMatches(token)) {
    headers.set("location", "/setup?error=token");
    return new Response(null, { status: 303, headers });
  }
  const base = appUrl();
  const origin = base ? setupOrigin(request.headers, base) : undefined;
  const secure = origin?.ok ? origin.secure : false;
  headers.append("set-cookie", `${SETUP_COOKIE}=${sessionValue()}; Path=/setup; Max-Age=3600; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`);
  return new Response(null, { status: 303, headers });
}
