/**
 * The proxy in front of the dashboards: sign-in redirects, the operator
 * rewrite to /ops, the ordinary 404 for everyone else (at /admin by falling
 * through, at /ops by a rewrite no route answers), and encoded paths. Runs
 * against a throwaway Postgres for the session check; skips without it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import postgres from "postgres";
import { NextRequest } from "next/server";
import { createDb, schema, type Db } from "@sandchest/db";
import { migrate } from "@sandchest/db/migrate";
import { normalisePath, proxy, sectionOf } from "@/proxy";
import { resetConfig } from "@/server/config";
import { setDb } from "@/server/db";

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest";
const NAME = `sandchest_proxy_test_${process.pid}`;
const SECRET = "proxy-test-secret-proxy-test-secret-01";

let admin: postgres.Sql | undefined;
let database: Db;
let available = true;
const saved = { ...process.env };

const sign = (token: string) => `${token}.${createHmac("sha256", SECRET).update(token).digest("base64")}`;

function request(path: string, options: { session?: string; headers?: Record<string, string> } = {}): NextRequest {
  const headers = new Headers(options.headers);
  if (options.session) headers.set("cookie", `better-auth.session_token=${encodeURIComponent(sign(options.session))}`);
  return new NextRequest(new URL(path, "http://sandchest.test"), { headers });
}

const isNext = (response: Response) => response.headers.get("x-middleware-next") === "1";
const rewrittenTo = (response: Response) => {
  const target = response.headers.get("x-middleware-rewrite");
  return target ? new URL(target).pathname + new URL(target).search : null;
};

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
  database = createDb(url.toString(), { max: 3 });
  await migrate(database);
  Object.assign(process.env, {
    DATABASE_URL: url.toString(),
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: "unused",
    GITHUB_WEBHOOK_SECRET: "unused",
    SANDCHEST_APP_URL: "http://sandchest.test",
    BETTER_AUTH_SECRET: SECRET,
    SANDCHEST_ADMIN_GITHUB_IDS: "5001",
  });
  resetConfig();
  setDb(database);
  const [operator, member] = await database
    .insert(schema.users)
    .values([
      { name: "Operator", email: "operator@example.com", githubUserId: 5001 },
      { name: "Member", email: "member@example.com", githubUserId: 5002 },
    ])
    .returning();
  const expiresAt = new Date(Date.now() + 86_400_000);
  await database.insert(schema.sessions).values([
    { userId: operator!.id, token: "operator", expiresAt },
    { userId: member!.id, token: "member", expiresAt },
  ]);
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

describe("paths", () => {
  test("are compared decoded and normalised", () => {
    expect(normalisePath("/%61dmin")).toBe("/admin");
    expect(normalisePath("/admin%2fcost")).toBe("/admin/cost");
    expect(normalisePath("//admin//cost/")).toBe("/admin/cost");
    expect(normalisePath("/%6f%70%73")).toBe("/ops");
    expect(normalisePath("/")).toBe("/");
    expect(normalisePath("/%E0%A4%A")).toBeUndefined();
    expect(["/admin", "/admin/cost", "/ops/funnel", "/repos", "/findings/x", "/administrator", "/opsx", "/"].map(sectionOf)).toEqual([
      "admin",
      "admin",
      "ops",
      "dashboard",
      "dashboard",
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe("proxy", () => {
  test("only an operator is rewritten to the dashboards; everyone else falls through to the ordinary 404", async () => {
    if (!available) return;
    expect(rewrittenTo(await proxy(request("/admin/cost?range=7", { session: "operator" })))).toBe("/ops/cost?range=7");
    expect(rewrittenTo(await proxy(request("/admin", { session: "operator" })))).toBe("/ops");
    for (const response of [await proxy(request("/admin")), await proxy(request("/admin/cost", { session: "member" })), await proxy(request("/admin", { session: "forged" }))]) {
      expect(isNext(response)).toBe(true);
      expect(rewrittenTo(response)).toBeNull();
    }
  });

  test("encoded paths are the same paths: never a sign-in redirect for the protected names", async () => {
    if (!available) return;
    for (const path of ["/%61dmin", "/admin%2fcost", "/%61dmin/funnel"]) {
      const signedOut = await proxy(request(path));
      expect(signedOut.status).not.toBe(307);
      expect(isNext(signedOut)).toBe(true);
    }
    expect(rewrittenTo(await proxy(request("/%61dmin", { session: "operator" })))).toBe("/ops");
    expect(rewrittenTo(await proxy(request("/admin%2fcost", { session: "operator" })))).toBe("/ops/cost");
    // A path that does not decode is left to Next.
    expect(isNext(await proxy(request("/%E0%A4%A")))).toBe(true);
  });

  test("/ops by name, however spelled and whoever asks, goes where no route can answer", async () => {
    if (!available) return;
    for (const [path, session] of [
      ["/ops", undefined],
      ["/ops/cost", "member"],
      ["/%6f%70%73", undefined],
      ["/ops", "operator"],
    ] as const) {
      const response = await proxy(request(path, { session }));
      // Not the static not-found page (which is cached for a year and answers prefetches with 200), not a redirect.
      expect(rewrittenTo(response)).toBe("/_none");
      expect(response.status).toBe(200);
    }
  });

  test("dashboard pages still send signed-out visitors to sign in", async () => {
    if (!available) return;
    const response = await proxy(request("/repos?x=1"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://sandchest.test/sign-in?next=%2Frepos%3Fx%3D1");
    expect(isNext(await proxy(request("/findings", { session: "member" })))).toBe(true);
  });
});
