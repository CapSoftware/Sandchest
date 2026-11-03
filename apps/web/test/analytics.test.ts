/**
 * First-party analytics: what the browser beacon lets through, and that it
 * records events against a real Postgres (local docker). The database part
 * skips without Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { createDb, EVENT_NAMES, recordDailyVisit, recordEvent, recordIdentified, schema, type Db } from "@sandchest/db";
import { migrate } from "@sandchest/db/migrate";
import { NextRequest } from "next/server";
import { ANON_COOKIE, BOT_AGENT, BROWSER_EVENTS, clickTarget, deviceOf, queryOf, referrerHost, routeOf, safeToken, utmOf, withUtm } from "@/lib/analytics";
import { resetConfig } from "@/server/config";
import { setDb } from "@/server/db";
import { POST } from "@/app/api/e/route";

describe("what is recorded", () => {
  test("paths keep their shape and lose their ids", () => {
    expect(routeOf("/")).toBe("/");
    expect(routeOf("/docs/self-hosting")).toBe("/docs/self-hosting");
    expect(routeOf("/dashboard/findings/0b6f6c8e-6d0c-4f7e-9d0a-1f2e3d4c5b6a")).toBe("/dashboard/findings/:id");
    expect(routeOf("/dashboard/scans/123?org=abc#feed")).toBe("/dashboard/scans/:id");
    // Anything unusual could be a name: an uppercase login, an encoded string, something long.
    expect(routeOf("/Octocat/Repo")).toBe("/:id/:id");
    expect(routeOf("/a%20b")).toBe("/:id");
    expect(routeOf("/%E0%A4%A")).toBe("/:id");
    expect(routeOf(`/${"x".repeat(41)}`)).toBe("/:id");
    expect(routeOf("/a/b/c/d/e/f/g/h/i/j").split("/").length).toBe(9);
  });

  test("referrers keep their host, and only from other sites", () => {
    expect(referrerHost("https://news.example.com/item?id=1", "sandchest.test")).toBe("news.example.com");
    expect(referrerHost("https://sandchest.test/docs", "sandchest.test")).toBeUndefined();
    expect(referrerHost("", "sandchest.test")).toBeUndefined();
    expect(referrerHost("not a url", "sandchest.test")).toBeUndefined();
  });

  test("known status and filter parameters survive as q_ props; everything else is dropped", () => {
    expect(queryOf("?error=1&plan=started&severity=critical&email=user@example.com&name=Octo%20Cat&next=/dashboard/repos/123")).toEqual({
      q_error: "1",
      q_plan: "started",
      q_severity: "critical",
      q_next: "/dashboard/repos/:id",
    });
    // A `next` that leaves the site, and values that aren't safe tokens, are dropped.
    expect(queryOf("?next=//evil.example&error=a%20b")).toEqual({});
  });

  test("links sent out carry where they were sent, before any fragment", () => {
    expect(withUtm("https://sandchest.test/dashboard/settings#billing", "email", "credits_low")).toBe("https://sandchest.test/dashboard/settings?utm_source=email&utm_medium=credits_low#billing");
    expect(withUtm("https://sandchest.test/dashboard/scans/1", "github", "check")).toBe("https://sandchest.test/dashboard/scans/1?utm_source=github&utm_medium=check");
  });

  test("only campaign tags survive from the query string, as safe tokens", () => {
    expect(utmOf("?utm_source=newsletter&utm_campaign=launch-1&email=user@example.com&utm_medium=a%20b")).toEqual({ utm_source: "newsletter", utm_campaign: "launch-1" });
    expect(utmOf("")).toEqual({});
  });

  test("clicks name a tracked control, an internal route or another site's host", () => {
    const origin = "https://sandchest.test";
    expect(clickTarget({ track: "hero-get-started", href: "/get-started" }, origin)).toBe("hero-get-started");
    expect(clickTarget({ href: "/dashboard/repos/0b6f6c8e-6d0c-4f7e-9d0a-1f2e3d4c5b6a" }, origin)).toBe("/dashboard/repos/:id");
    expect(clickTarget({ href: "https://github.com/acme/app/blob/main/a.ts#L1" }, origin)).toBe("github.com");
    expect(clickTarget({ href: "mailto:user@example.com" }, origin)).toBeUndefined();
    expect(clickTarget({ href: "javascript:void 0" }, origin)).toBeUndefined();
    // A button's text could name someone: without an id it is not recorded.
    expect(clickTarget({ track: null, href: null }, origin)).toBeUndefined();
    expect(clickTarget({ track: "has spaces" }, origin)).toBeUndefined();
  });

  test("tokens, devices and bots", () => {
    expect(safeToken("  ok-1.2/x:y  ")).toBe("ok-1.2/x:y");
    expect(safeToken("user@example.com")).toBeUndefined();
    expect(safeToken("x".repeat(100), 10)).toBe("x".repeat(10));
    expect([deviceOf(390), deviceOf(800), deviceOf(1440)]).toEqual(["mobile", "tablet", "desktop"]);
    expect(BOT_AGENT.test("Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe(true);
    expect(BOT_AGENT.test("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15")).toBe(false);
  });

  test("every browser event is a known event", () => {
    for (const name of BROWSER_EVENTS) expect(EVENT_NAMES).toContain(name);
  });
});

// ---- The beacon against Postgres --------------------------------------------

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest";
const NAME = `sandchest_analytics_test_${process.pid}`;
let admin: postgres.Sql | undefined;
let database: Db;
let available = true;
const saved = { ...process.env };

beforeAll(async () => {
  try {
    admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${NAME}`);
  } catch {
    available = false;
    return;
  }
  const url = new URL(ADMIN_URL);
  url.pathname = `/${NAME}`;
  database = createDb(url.toString(), { max: 5 });
  await migrate(database);
  Object.assign(process.env, { DATABASE_URL: url.toString(), GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "k", GITHUB_WEBHOOK_SECRET: "s", SANDCHEST_APP_URL: "https://sandchest.test" });
  resetConfig();
  setDb(database);
});

afterAll(async () => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  resetConfig();
  if (!available) return;
  await database.$client.end();
  await admin!.unsafe(`drop database if exists ${NAME} with (force)`);
  await admin!.end();
});

const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15";
const HINT = "7d9f2c1e-4b3a-4c5d-8e6f-0a1b2c3d4e5f";

/** A beacon request. One event is sent as the browser sends it: a batch of one, with the tab's hint. */
function beacon(body: unknown, headers: Record<string, string> = {}): NextRequest {
  let payload = body;
  if (body && typeof body === "object" && "name" in body) {
    const { hint, ...event } = body as Record<string, unknown>;
    payload = { events: [event], hint };
  }
  return new NextRequest("https://sandchest.test/api/e", {
    method: "POST",
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
    headers: { "content-type": "application/json", "user-agent": BROWSER, ...headers },
  });
}

/** The events recorded so far: recording happens in the background, so this waits for the expected count. */
async function recorded(expected: number) {
  for (let i = 0; i < 50; i++) {
    const rows = await database.select().from(schema.events).orderBy(schema.events.id);
    if (rows.length >= expected) return rows;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return database.select().from(schema.events).orderBy(schema.events.id);
}

describe("the beacon", () => {
  test("records a page view with only what is allowed, and sets the anonymous cookie", async () => {
    if (!available) return;
    await database.delete(schema.events);
    const response = await POST(
      beacon(
        {
          name: "page_view",
          path: "/dashboard/findings/0b6f6c8e-6d0c-4f7e-9d0a-1f2e3d4c5b6a?email=user@example.com",
          hint: HINT,
          referrer: "news.example.com",
          device: "desktop",
          search: "?utm_source=newsletter&utm_campaign=has%20spaces&email=user@example.com&error=1&next=/dashboard/findings/0b6f6c8e-6d0c-4f7e-9d0a-1f2e3d4c5b6a",
        },
        { "x-vercel-ip-country": "IE" },
      ),
    );
    expect(response.status).toBe(204);
    // The tab's hint becomes the cookie, so the first page's events agree.
    const cookie = response.cookies.get(ANON_COOKIE);
    expect(cookie?.value).toBe(HINT);
    expect(cookie?.httpOnly).toBe(true);
    const [row] = await recorded(1);
    expect(row).toMatchObject({ name: "page_view", anonId: HINT, userId: null, orgId: null });
    // Only the campaign tag and known status parameters survive; `next` is reduced to a route.
    expect(row!.props).toEqual({ path: "/dashboard/findings/:id", referrer: "news.example.com", device: "desktop", utm_source: "newsletter", q_error: "1", q_next: "/dashboard/findings/:id", country: "IE" });
  });

  test("the cookie wins over the hint, and is not set again", async () => {
    if (!available) return;
    await database.delete(schema.events);
    const anon = "11111111-2222-4333-8444-555555555555";
    const response = await POST(beacon({ name: "clicked", path: "/", target: "hero-get-started", hint: HINT }, { cookie: `${ANON_COOKIE}=${anon}` }));
    expect(response.status).toBe(204);
    expect(response.cookies.get(ANON_COOKIE)).toBeUndefined();
    const [row] = await recorded(1);
    expect(row).toMatchObject({ name: "clicked", anonId: anon, props: { path: "/", target: "hero-get-started" } });
  });

  test("records how long a page was on screen", async () => {
    if (!available) return;
    await database.delete(schema.events);
    await POST(beacon({ name: "page_left", path: "/docs/pricing", visible_ms: 12_345, hint: HINT }));
    const [row] = await recorded(1);
    expect(row).toMatchObject({ name: "page_left", props: { path: "/docs/pricing", visible_ms: 12_345 } });
  });

  test("records flow steps", async () => {
    if (!available) return;
    await database.delete(schema.events);
    await POST(beacon({ name: "step_viewed", path: "/get-started", flow: "recruit", step: "company", hint: HINT }));
    const [row] = await recorded(1);
    expect(row).toMatchObject({ name: "step_viewed", props: { path: "/get-started", flow: "recruit", step: "company" } });
  });

  test("ignores bots, junk, unknown events and anything oversized, always with 204", async () => {
    if (!available) return;
    await database.delete(schema.events);
    const responses = await Promise.all([
      POST(beacon({ name: "page_view", path: "/" }, { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" })),
      POST(beacon("not json")),
      POST(beacon({ name: "signed_up", path: "/" })),
      POST(beacon({ name: "clicked", path: "/", target: "user@example.com" })),
      POST(beacon({ name: "step_viewed", path: "/", flow: "other", step: "x" })),
      POST(beacon({ name: "page_view", path: "/", referrer: "x".repeat(3_000) })),
    ]);
    expect(responses.map((r) => r.status)).toEqual([204, 204, 204, 204, 204, 204]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await database.select().from(schema.events)).toEqual([]);
  });

  test("records a page's events in one request, dropping only the ones that don't pass", async () => {
    if (!available) return;
    await database.delete(schema.events);
    const events = [
      { name: "page_left", path: "/docs", visible_ms: 4_000 },
      { name: "clicked", path: "/docs", target: "docs-copy-code" },
      { name: "clicked", path: "/docs", target: "user@example.com" },
      { name: "signed_up", path: "/docs" },
      { name: "page_view", path: "/pricing", search: "?plan=started" },
    ];
    await POST(beacon({ events, hint: HINT }));
    const rows = await recorded(3);
    expect(rows.map((row) => [row.name, row.props])).toEqual([
      ["page_left", { path: "/docs", visible_ms: 4_000 }],
      ["clicked", { path: "/docs", target: "docs-copy-code" }],
      ["page_view", { path: "/pricing", q_plan: "started" }],
    ]);
    // One insert: every row shares the transaction's timestamp.
    expect(new Set(rows.map((row) => row.createdAt.getTime())).size).toBe(1);
  });

  test("never reads the database: browser events carry the browser, not the person", async () => {
    if (!available) return;
    await database.delete(schema.events);
    // Even with a session cookie, the beacon doesn't look the person up; `identified` and `signed_in` tie them.
    await POST(beacon({ name: "page_view", path: "/dashboard", hint: HINT }, { cookie: "better-auth.session_token=anything.signed" }));
    const [row] = await recorded(1);
    expect(row).toMatchObject({ anonId: HINT, userId: null });
  });

  test("oversized batches are dropped whole", async () => {
    if (!available) return;
    await database.delete(schema.events);
    const events = Array.from({ length: 26 }, () => ({ name: "clicked", path: "/", target: "x" }));
    expect((await POST(beacon({ events, hint: HINT }))).status).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await database.select().from(schema.events)).toEqual([]);
  });

  test("a bad hint gets a fresh anonymous id", async () => {
    if (!available) return;
    await database.delete(schema.events);
    const response = await POST(beacon({ name: "page_view", path: "/", hint: "not-a-uuid" }));
    const value = response.cookies.get(ANON_COOKIE)?.value;
    expect(value).toMatch(/^[0-9a-f-]{36}$/);
    const [row] = await recorded(1);
    expect(row!.anonId).toBe(value!);
  });
});

describe("writes", () => {
  test("a browser is tied to a person once, and a visit counted once a day, however often they're recorded", async () => {
    if (!available) return;
    await database.delete(schema.events);
    const [person] = await database.insert(schema.users).values({ name: "Analytics", email: "user@example.com" }).returning();
    await Promise.all([recordIdentified(database, person!.id, HINT), recordIdentified(database, person!.id, HINT), recordDailyVisit(database, person!.id, HINT), recordDailyVisit(database, person!.id, HINT)]);
    const rows = await database.select().from(schema.events);
    expect(rows.map((row) => row.name).sort()).toEqual(["dashboard_visit", "identified"]);
    await database.delete(schema.users);
  });

  test("an analytics write gives way to a lock instead of waiting on it", async () => {
    if (!available) return;
    await database.delete(schema.events);
    // Something holds the events table (a migration, say): the write is dropped after a short wait, not queued behind it.
    const holder = await database.$client.reserve();
    await holder`begin`;
    await holder`lock table events in access exclusive mode`;
    const started = performance.now();
    const error = await recordEvent(database, { name: "page_view", anonId: HINT, props: { path: "/" } }).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    const waited = performance.now() - started;
    await holder`rollback`;
    holder.release();
    expect(error).toBeDefined();
    expect(waited).toBeLessThan(1_500);
  });
});
