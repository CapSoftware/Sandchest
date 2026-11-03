/**
 * First-party analytics: what the browser beacon lets through, and that it
 * records events against a real Postgres (local docker). The database part
 * skips without Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { createDb, EVENT_NAMES, schema, type Db } from "@sandchest/db";
import { migrate } from "@sandchest/db/migrate";
import { NextRequest } from "next/server";
import { ANON_COOKIE, BOT_AGENT, BROWSER_EVENTS, clickTarget, deviceOf, referrerHost, routeOf, safeToken, utmOf } from "@/lib/analytics";
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

function beacon(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("https://sandchest.test/api/e", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
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
          utm: { utm_source: "newsletter", utm_campaign: "has spaces" },
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
    expect(row!.props).toEqual({ path: "/dashboard/findings/:id", referrer: "news.example.com", device: "desktop", utm_source: "newsletter", country: "IE" });
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
