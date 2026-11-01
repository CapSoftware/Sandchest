/**
 * Self-hosting: the gateway that keeps the workflow routes off the public
 * port, first-run setup's token, session, state and redirect rules, and the
 * start-up migrations (against a real Postgres, skipped without one).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import http from "node:http";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import postgres from "postgres";
import { createGateway, isBlocked, stopGateway } from "../../../docker/server.mjs";
import { GET as unlockGet, POST as unlockPost } from "@/app/setup/unlock/route";
import {
  newState,
  sessionValid,
  sessionValue,
  setupAnnouncement,
  setupNeeded,
  setupOrigin,
  setupToken,
  stateValid,
  tokenMatches,
} from "@/server/setup";
import { config } from "@/server/config";
import { migrateAll } from "../scripts/migrate";

// ---- Gateway --------------------------------------------------------------

describe("gateway: the workflow routes are not reachable from outside", () => {
  test("every spelling of the workflow routes is refused", () => {
    for (const target of [
      "/.well-known/workflow/v1/flow",
      "/.well-known/workflow/v1/flow?__health",
      "/.well-known/workflow/v1/flow/",
      "/.well-known/workflow/v1/webhook/abc",
      "/.well-known/workflow/v1/manifest.json",
      "/.well-known/workflow",
      "/.WELL-KNOWN/Workflow/v1/flow",
      "//.well-known//workflow/v1/flow",
      "/.well-known/./workflow/v1/flow",
      "/x/../.well-known/workflow/v1/flow",
      "/.well-known/x/../workflow/v1/flow",
      "/x%3F/../.well-known/workflow/v1/flow",
      "/%2Ewell-known/workflow/v1/flow",
      "/%2ewell-known%2fworkflow%2fv1%2fflow",
      "/%252Ewell-known/workflow/v1/flow",
      "/.well-known%5Cworkflow/v1/flow",
      "/.well-known\\workflow\\v1\\flow",
      "/.well-known/workflow;/v1/flow",
      "/.well-known/%77orkflow/v1/flow",
      "/%E0%A4%A",
      "http://localhost/.well-known/workflow/v1/flow",
      "*",
      "",
    ]) {
      expect([target, isBlocked(target)]).toEqual([target, true]);
    }
  });

  test("everything else goes through", () => {
    for (const target of ["/", "/sign-in?next=%2Frepos", "/setup", "/api/github/webhooks", "/.well-known/security.txt", "/api/scans/abc/events?after=3", "/_next/static/chunks/app.js"]) {
      expect([target, isBlocked(target)]).toEqual([target, false]);
    }
  });

  let upstream: http.Server;
  let gateway: http.Server;
  let port = 0;
  const seen: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> = [];

  beforeAll(async () => {
    upstream = http.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        seen.push({ method: request.method!, url: request.url!, headers: request.headers, body });
        if (request.url === "/stream") {
          // A live feed: the first event must arrive before the stream ends.
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write("data: one\n\n");
          setTimeout(() => response.end("data: two\n\n"), 300);
          return;
        }
        response.writeHead(200, { "content-type": "text/plain", "set-cookie": ["a=1", "b=2"] });
        response.end(`ok ${request.method} ${request.url}`);
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    gateway = createGateway({ upstreamPort: (upstream.address() as AddressInfo).port });
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    port = (gateway.address() as AddressInfo).port;
  });

  afterAll(() => {
    gateway?.close();
    upstream?.close();
  });

  /** Sends bytes exactly as written: fetch would normalise the path first. */
  function raw(requestLine: string, extra = ""): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => socket.write(`${requestLine}\r\nhost: localhost\r\nconnection: close\r\n${extra}\r\n`));
      let data = "";
      socket.on("data", (chunk) => (data += chunk));
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });
  }

  test("forwards requests with their body, method and cookies, without internal routing headers", async () => {
    seen.length = 0;
    const response = await fetch(`http://127.0.0.1:${port}/api/github/webhooks?x=1`, {
      method: "POST",
      body: JSON.stringify({ zen: "hi" }),
      headers: { "content-type": "application/json", "x-middleware-subrequest": "middleware", "x-invoke-path": "/.well-known/workflow/v1/flow", "x-matched-path": "/.well-known/workflow/v1/flow", "x-github-event": "ping" },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok POST /api/github/webhooks?x=1");
    expect(response.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
    const [request] = seen;
    expect(request!.body).toBe('{"zen":"hi"}');
    expect(request!.headers["x-github-event"]).toBe("ping");
    expect(request!.headers["x-middleware-subrequest"]).toBeUndefined();
    expect(request!.headers["x-invoke-path"]).toBeUndefined();
    expect(request!.headers["x-matched-path"]).toBeUndefined();
    expect(request!.headers["x-forwarded-for"]).toBe("127.0.0.1");
  });

  test("refuses the workflow routes before they reach the app, whatever the method or spelling", async () => {
    seen.length = 0;
    for (const target of ["/.well-known/workflow/v1/flow", "/x/../.well-known/workflow/v1/flow", "/%2Ewell-known/workflow/v1/flow", "//.well-known/workflow/v1/flow"]) {
      for (const method of ["POST", "GET", "HEAD", "OPTIONS"]) {
        expect(await raw(`${method} ${target} HTTP/1.1`, "content-length: 2\r\n")).toStartWith("HTTP/1.1 404");
      }
    }
    expect(await raw("POST http://localhost/.well-known/workflow/v1/flow HTTP/1.1")).toStartWith("HTTP/1.1 404");
    expect(seen).toEqual([]);
  });

  test("streams server-sent events as they are written", async () => {
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${port}/stream`);
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toBe("data: one\n\n");
    expect(Date.now() - started).toBeLessThan(250);
    await reader.cancel();
  });

  test("answers 502 while the app is down", async () => {
    const lonely = createGateway({ upstreamPort: 1 });
    await new Promise<void>((resolve) => lonely.listen(0, "127.0.0.1", resolve));
    const response = await fetch(`http://127.0.0.1:${(lonely.address() as AddressInfo).port}/`);
    expect(response.status).toBe(502);
    lonely.close();
  });

  test("stopping ends open streams, so the app behind it can shut down", async () => {
    let upstreamClosed = false;
    const app = http.createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: open\n\n");
      request.socket.on("close", () => (upstreamClosed = true));
    });
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    const front = createGateway({ upstreamPort: (app.address() as AddressInfo).port });
    await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve));
    const response = await fetch(`http://127.0.0.1:${(front.address() as AddressInfo).port}/feed`);
    await response.body!.getReader().read();
    stopGateway(front);
    // The app's own close() completes only once nothing holds a connection to it.
    await new Promise<void>((resolve) => app.close(() => resolve()));
    expect(upstreamClosed).toBe(true);
  });
});

// ---- Setup ----------------------------------------------------------------

describe("setup", () => {
  const env = { BETTER_AUTH_SECRET: "s".repeat(40), SANDCHEST_APP_URL: "https://sandchest.example.com" };

  test("is needed only until a GitHub App is configured", () => {
    expect(setupNeeded({})).toBe(true);
    expect(setupNeeded({ GITHUB_APP_ID: " " })).toBe(true);
    expect(setupNeeded({ GITHUB_APP_ID: "123" })).toBe(false);
    expect(setupAnnouncement({ ...env, GITHUB_APP_ID: "123" })).toBeUndefined();
  });

  test("the token comes from the auth secret, or the explicit setting, and is printed while setup is needed", () => {
    const derived = setupToken(env)!;
    expect(derived).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(derived).not.toContain(env.BETTER_AUTH_SECRET);
    expect(setupToken({ ...env, BETTER_AUTH_SECRET: "t".repeat(40) })).not.toBe(derived);
    expect(setupToken({ ...env, SANDCHEST_SETUP_TOKEN: "x".repeat(30) })).toBe("x".repeat(30));
    // Too short to be a secret: setup stays shut.
    expect(setupToken({ ...env, SANDCHEST_SETUP_TOKEN: "short" })).toBeUndefined();
    expect(setupToken({ BETTER_AUTH_SECRET: "short" })).toBeUndefined();
    expect(setupAnnouncement(env)).toContain(`https://sandchest.example.com/setup/unlock?token=${derived}`);
    expect(setupAnnouncement({ BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET })).toContain("Set SANDCHEST_APP_URL");
    expect(setupAnnouncement({ SANDCHEST_APP_URL: env.SANDCHEST_APP_URL })).toContain("Set BETTER_AUTH_SECRET");
  });

  test("tokens are compared exactly", () => {
    const token = setupToken(env)!;
    expect(tokenMatches(token, env)).toBe(true);
    expect(tokenMatches(` ${token} `, env)).toBe(true);
    expect(tokenMatches(token.slice(1), env)).toBe(false);
    expect(tokenMatches("", env)).toBe(false);
    expect(tokenMatches(null, env)).toBe(false);
    expect(tokenMatches(token, {})).toBe(false);
  });

  test("sessions last an hour and die with the token", () => {
    const now = Date.now();
    const value = sessionValue(env, now);
    expect(sessionValid(value, env, now)).toBe(true);
    expect(sessionValid(value, env, now + 59 * 60_000)).toBe(true);
    expect(sessionValid(value, env, now + 61 * 60_000)).toBe(false);
    expect(sessionValid(value, { ...env, BETTER_AUTH_SECRET: "u".repeat(40) }, now)).toBe(false);
    const [expires, mac] = value.split(".");
    expect(sessionValid(`${Number(expires) + 10 * 3_600_000}.${mac}`, env, now)).toBe(false);
    expect(sessionValid(`${value}.x`, env, now)).toBe(false);
    expect(sessionValid(undefined, env, now)).toBe(false);
  });

  test("states are single-origin: signed, unique, expiring", () => {
    const now = Date.now();
    const a = newState(env, now);
    expect(a).not.toBe(newState(env, now));
    expect(stateValid(a, env, now)).toBe(true);
    expect(stateValid(a, env, now + 61 * 60_000)).toBe(false);
    const [expires, , mac] = a.split(".");
    expect(stateValid(`${expires}.other-nonce.${mac}`, env, now)).toBe(false);
    expect(stateValid(a, { ...env, SANDCHEST_SETUP_TOKEN: "y".repeat(30) }, now)).toBe(false);
    expect(stateValid(null, env, now)).toBe(false);
    // A repeated query parameter arrives as an array.
    expect(stateValid([a, a] as unknown as string, env, now)).toBe(false);
  });

  test("GitHub sends people back only to the public URL, or to loopback on the operator's machine", () => {
    const base = "https://sandchest.example.com";
    const on = (init: Record<string, string>) => setupOrigin(new Headers(init), base);
    expect(on({ host: "sandchest.example.com" })).toEqual({ ok: true, redirectUrl: `${base}/setup/callback`, secure: true });
    expect(on({ host: "localhost:3000", "x-forwarded-host": "SANDCHEST.example.com" })).toEqual({ ok: true, redirectUrl: `${base}/setup/callback`, secure: true });
    expect(on({ host: "localhost:3401" })).toEqual({ ok: true, redirectUrl: "http://localhost:3401/setup/callback", secure: false });
    expect(on({ host: "127.0.0.1:3000" })).toEqual({ ok: true, redirectUrl: "http://127.0.0.1:3000/setup/callback", secure: false });
    expect(on({ host: "[::1]:3000" })).toEqual({ ok: true, redirectUrl: "http://[::1]:3000/setup/callback", secure: false });
    for (const host of ["evil.example", "sandchest.example.com.evil.example", "localhost.evil.example", "192.168.1.10:3000", ""]) {
      expect(on({ host })).toEqual({ ok: false, setupUrl: `${base}/setup` });
    }
  });

  describe("unlocking", () => {
    const saved = { ...process.env };
    beforeAll(() => {
      delete process.env.GITHUB_APP_ID;
      delete process.env.SANDCHEST_SETUP_TOKEN;
      Object.assign(process.env, env);
    });
    afterAll(() => {
      for (const key of ["BETTER_AUTH_SECRET", "SANDCHEST_APP_URL", "GITHUB_APP_ID"]) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });
    const request = (url: string, init?: RequestInit) => new Request(url, { ...init, headers: { host: "sandchest.example.com", ...init?.headers } });

    test("the printed link sets an hour-long, HTTP-only cookie and drops the token from the address", () => {
      const response = unlockGet(request(`https://sandchest.example.com/setup/unlock?token=${setupToken(env)}`));
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/setup");
      const cookie = response.headers.get("set-cookie")!;
      expect(cookie).toMatch(/^sandchest_setup=\d+\.[\w-]+; Path=\/setup; Max-Age=3600; HttpOnly; SameSite=Lax; Secure$/);
      expect(sessionValid(cookie.split(";")[0]!.split("=")[1], env)).toBe(true);
      expect(cookie).not.toContain(setupToken(env)!);
    });

    test("a wrong token sets nothing", async () => {
      for (const response of [
        unlockGet(request("https://sandchest.example.com/setup/unlock?token=nope")),
        unlockGet(request("https://sandchest.example.com/setup/unlock")),
        await unlockPost(request("https://sandchest.example.com/setup/unlock", { method: "POST", body: new URLSearchParams({ token: "nope" }) })),
      ]) {
        expect(response.status).toBe(303);
        expect(response.headers.get("location")).toBe("/setup?error=token");
        expect(response.headers.get("set-cookie")).toBeNull();
      }
    });

    test("the token can be pasted, and the cookie is not Secure on plain-HTTP loopback", async () => {
      const response = await unlockPost(
        new Request("http://localhost:3401/setup/unlock", { method: "POST", body: new URLSearchParams({ token: setupToken(env)! }), headers: { host: "localhost:3401" } }),
      );
      expect(response.headers.get("set-cookie")).not.toContain("Secure");
      expect(response.headers.get("location")).toBe("/setup");
    });

    test("is gone once the App is configured", () => {
      process.env.GITHUB_APP_ID = "123";
      expect(unlockGet(request(`https://sandchest.example.com/setup/unlock?token=${setupToken(env)}`)).status).toBe(404);
      delete process.env.GITHUB_APP_ID;
    });
  });
});

// ---- Configuration --------------------------------------------------------

describe("configuration", () => {
  test("a blank value is unset, as Docker Compose passes settings left empty in .env", () => {
    const settings = config({
      DATABASE_URL: "postgres://sandchest@postgres/sandchest",
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: "key",
      GITHUB_WEBHOOK_SECRET: "secret",
      SANDCHEST_APP_URL: "https://sandchest.example.com",
      SMTP_URL: "",
      EMAIL_FROM: "",
      GITHUB_APP_SLUG: "",
      SANDCHEST_ADMIN_TOKEN: "  ",
    });
    expect(settings.SMTP_URL).toBeUndefined();
    expect(settings.GITHUB_APP_SLUG).toBeUndefined();
    expect(settings.SANDCHEST_ADMIN_TOKEN).toBeUndefined();
    expect(settings.workspace).toBe("local");
    expect(() => config({ DATABASE_URL: "postgres://x", GITHUB_APP_ID: "", SANDCHEST_APP_URL: "https://x.test" })).toThrow("GITHUB_APP_ID");
  });
});

// ---- Migrations -----------------------------------------------------------

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest";
const NAME = `sandchest_selfhost_test_${process.pid}`;
let admin: postgres.Sql | undefined;
let available = true;
let url = "";

describe("start-up migrations", () => {
  beforeAll(async () => {
    try {
      admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
      await admin.unsafe(`create database ${NAME}`);
      const parsed = new URL(ADMIN_URL);
      parsed.pathname = `/${NAME}`;
      url = parsed.toString();
    } catch {
      available = false;
    }
  });

  afterAll(async () => {
    if (!admin) return;
    if (available) await admin.unsafe(`drop database if exists ${NAME} with (force)`);
    await admin.end();
  });

  test("installs the same queue version the World runs", async () => {
    // Not in the package's exports: read it from where the package resolves.
    const entry = Bun.resolveSync("@workflow/world-postgres", import.meta.dir);
    const world = (await Bun.file(join(dirname(entry), "..", "package.json")).json()) as { dependencies: Record<string, string> };
    const web = (await import("../package.json", { with: { type: "json" } })).default as { devDependencies: Record<string, string> };
    expect(web.devDependencies["graphile-worker"]).toBe(world.dependencies["graphile-worker"]);
  });

  test("servers starting together take turns, and a second run changes nothing", async () => {
    if (!available) return;
    const urls = { app: url, world: url };
    await Promise.all([migrateAll(urls), migrateAll(urls), migrateAll(urls)]);
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    try {
      const schemas = (await sql`select nspname from pg_namespace where nspname in ('workflow', 'workflow_drizzle', 'graphile_worker', 'drizzle')`).map((r) => r.nspname as string).sort();
      expect(schemas).toEqual(["drizzle", "graphile_worker", "workflow", "workflow_drizzle"]);
      const [{ count: applied }] = await sql`select count(*)::int as count from drizzle.__drizzle_migrations`;
      const [{ count: world }] = await sql`select count(*)::int as count from workflow_drizzle.workflow_migrations`;
      expect(applied).toBeGreaterThanOrEqual(3);
      expect(world).toBeGreaterThan(20);
      await migrateAll(urls);
      const [{ count: again }] = await sql`select count(*)::int as count from drizzle.__drizzle_migrations`;
      expect(again).toBe(applied);
      // The app's tables exist and the lock was released.
      await sql`select 1 from scans limit 1`;
      const [{ locked }] = await sql`select count(*)::int as locked from pg_locks where locktype = 'advisory' and database = (select oid from pg_database where datname = current_database())`;
      expect(locked).toBe(0);
    } finally {
      await sql.end();
    }
  }, 60_000);
});
