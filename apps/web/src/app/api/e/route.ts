/**
 * The analytics beacon: page views, clicks and flow steps from the browser
 * (see `components/analytics.tsx`). It sets the anonymous `sc_aid` cookie on
 * the first event, ties events to the signed-in person when there is one,
 * and records only what `lib/analytics` lets through: routes without ids,
 * referrer hosts, campaign tags and enums. Always answers 204, so a page
 * never waits on it or learns anything from it.
 */
import { randomUUID } from "node:crypto";
import { recordEvent, type EventProps } from "@sandchest/db";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ANON_COOKIE, ANON_COOKIE_MAX_AGE_S, BOT_AGENT, DEVICES, isUuid, queryOf, routeOf, safeToken, utmOf } from "@/lib/analytics";
import { currentUser } from "@/server/access";
import { later } from "@/server/analytics";
import { db } from "@/server/db";

/** The largest event the browser sends is a few hundred bytes. */
const MAX_BYTES = 2_048;

const Token = z.string().max(200);
const Base = {
  /** The page's path; reduced to its route here, whatever the browser sent. */
  path: z.string().max(1_000),
  /** The tab's own id, used as the anonymous id until the cookie is set, so a first page's events agree. */
  hint: z.string().max(64).optional(),
};
const Beacon = z.discriminatedUnion("name", [
  z.object({
    name: z.literal("page_view"),
    ...Base,
    referrer: Token.optional(),
    device: z.enum(DEVICES).optional(),
    /** The page's query string; only campaign tags and known status parameters are kept. */
    search: z.string().max(1_000).optional(),
  }),
  z.object({ name: z.literal("page_left"), ...Base, visible_ms: z.number().int().min(0).max(86_400_000) }),
  z.object({ name: z.literal("clicked"), ...Base, target: Token }),
  z.object({ name: z.literal("step_viewed"), ...Base, flow: z.enum(["recruit"]), step: Token }),
]);

const empty = () => new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } });

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (BOT_AGENT.test(request.headers.get("user-agent") ?? "")) return empty();
  const raw = await request.text().catch(() => "");
  if (!raw || raw.length > MAX_BYTES) return empty();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return empty();
  }
  const parsed = Beacon.safeParse(body);
  if (!parsed.success) return empty();
  const event = parsed.data;

  const cookie = request.cookies.get(ANON_COOKIE)?.value;
  const anon = isUuid(cookie) ? cookie : isUuid(event.hint) ? event.hint.toLowerCase() : randomUUID();
  const user = await currentUser().catch(() => undefined);

  const props: EventProps = { path: routeOf(event.path) };
  if (event.name === "page_view") {
    const referrer = safeToken(event.referrer, 100);
    if (referrer) props.referrer = referrer;
    if (event.device) props.device = event.device;
    Object.assign(props, utmOf(event.search ?? ""), queryOf(event.search ?? ""));
    // Set by Vercel's edge; elsewhere absent (and only ever a two-letter code).
    const country = request.headers.get("x-vercel-ip-country");
    if (country && /^[A-Z]{2}$/.test(country)) props.country = country;
  } else if (event.name === "page_left") {
    props.visible_ms = event.visible_ms;
  } else if (event.name === "clicked") {
    const target = safeToken(event.target, 100);
    if (!target) return empty();
    props.target = target;
  } else {
    const step = safeToken(event.step, 32);
    if (!step) return empty();
    props.flow = event.flow;
    props.step = step;
  }

  later(() => recordEvent(db(), { name: event.name, userId: user?.id ?? null, anonId: anon, props }));

  const response = empty();
  if (cookie !== anon) {
    response.cookies.set(ANON_COOKIE, anon, {
      path: "/",
      maxAge: ANON_COOKIE_MAX_AGE_S,
      sameSite: "lax",
      httpOnly: true,
      secure: request.nextUrl.protocol === "https:",
    });
  }
  return response;
}
