/**
 * The analytics beacon: page views, time on page, clicks and flow steps from
 * the browser (see `components/analytics.tsx`), a page's worth at a time. It
 * sets the anonymous `sc_aid` cookie on the first request and records only
 * what `lib/analytics` lets through: routes without ids, referrer hosts,
 * campaign tags, known status parameters and enums.
 *
 * It never reads the database: events are tied to people by the
 * `signed_in`/`identified` events that carry both ids (see ANALYTICS.md), and
 * written in one bounded insert after the response, on the analytics
 * connection. Always answers 204, so a page never waits on it or learns
 * anything from it.
 */
import { randomUUID } from "node:crypto";
import { MAX_EVENTS_PER_WRITE, type AnalyticsEvent, type EventProps } from "@sandchest/db";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ANON_COOKIE, ANON_COOKIE_MAX_AGE_S, BOT_AGENT, DEVICES, isUuid, queryOf, routeOf, safeToken, utmOf } from "@/lib/analytics";
import { recordLater } from "@/server/analytics";

/** A page's events are a few hundred bytes each. */
const MAX_BYTES = 16_384;
/** At most this many events in one request; the browser sends far fewer. */
const MAX_EVENTS = 25;

const Token = z.string().max(200);
const Path = z.string().max(1_000);
const Event = z.discriminatedUnion("name", [
  z.object({
    name: z.literal("page_view"),
    path: Path,
    referrer: Token.optional(),
    device: z.enum(DEVICES).optional(),
    /** The page's query string; only campaign tags and known status parameters are kept. */
    search: z.string().max(1_000).optional(),
  }),
  z.object({ name: z.literal("page_left"), path: Path, visible_ms: z.number().int().min(0).max(86_400_000) }),
  z.object({ name: z.literal("clicked"), path: Path, target: Token }),
  z.object({ name: z.literal("step_viewed"), path: Path, flow: z.enum(["recruit"]), step: Token }),
]);
type Event = z.infer<typeof Event>;

const Batch = z.object({
  events: z.array(z.unknown()).min(1).max(MAX_EVENTS),
  /** The tab's own id, used as the anonymous id until the cookie is set, so a first page's events agree. */
  hint: z.string().max(64).optional(),
});

const empty = () => new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } });

/** What is recorded of one event, or nothing if it doesn't pass. */
function propsOf(event: Event, country: string | null): EventProps | undefined {
  const props: EventProps = { path: routeOf(event.path) };
  if (event.name === "page_view") {
    const referrer = safeToken(event.referrer, 100);
    if (referrer) props.referrer = referrer;
    if (event.device) props.device = event.device;
    Object.assign(props, utmOf(event.search ?? ""), queryOf(event.search ?? ""));
    if (country) props.country = country;
  } else if (event.name === "page_left") {
    props.visible_ms = event.visible_ms;
  } else if (event.name === "clicked") {
    const target = safeToken(event.target, 100);
    if (!target) return undefined;
    props.target = target;
  } else {
    const step = safeToken(event.step, 32);
    if (!step) return undefined;
    props.flow = event.flow;
    props.step = step;
  }
  return props;
}

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
  const batch = Batch.safeParse(body);
  if (!batch.success) return empty();

  const cookie = request.cookies.get(ANON_COOKIE)?.value;
  const hint = batch.data.hint;
  const anon = isUuid(cookie) ? cookie : isUuid(hint) ? hint.toLowerCase() : randomUUID();
  // Set by Vercel's edge; elsewhere absent (and only ever a two-letter code).
  const header = request.headers.get("x-vercel-ip-country");
  const country = header && /^[A-Z]{2}$/.test(header) ? header : null;

  const events: AnalyticsEvent[] = [];
  for (const item of batch.data.events) {
    const event = Event.safeParse(item);
    const props = event.success ? propsOf(event.data, country) : undefined;
    if (event.success && props) events.push({ name: event.data.name, anonId: anon, props });
  }
  recordLater(events.slice(0, MAX_EVENTS_PER_WRITE));

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
