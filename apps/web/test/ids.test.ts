/**
 * Ids in links: anything that isn't a UUID is not found before it reaches
 * Postgres, which would otherwise fail the query on a `uuid` column and turn
 * a mistyped link into a 500. The events route runs against a real Postgres
 * (local docker); it skips without one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { createDb, schema, upsertInstallation, type Db } from "@sandchest/db";
import { migrate } from "@sandchest/db/migrate";
import { GET as events } from "@/app/api/scans/[id]/events/route";
import { parse as parseFindings } from "@/app/dashboard/findings/findings-view";
import { parse as parseScans } from "@/app/dashboard/scans/scans-view";
import { resetConfig } from "@/server/config";
import { setDb } from "@/server/db";

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest";
const NAME = `sandchest_ids_test_${process.pid}`;
const TOKEN = "operator-token-for-the-ids-test";

const REAL = "3f2b8c1e-9a4d-4e7b-8c2f-1d6a5b4c3e2f";
/** 36 characters of hex and dashes, but not a UUID. */
const MALFORMED = ["-".repeat(36), "3f2b8c1e9-a4d-4e7b-8c2f-1d6a5b4c3e2f", "3f2b8c1e-9a4d-4e7b-8c2f1d6a5b4c3e2f-", "f".repeat(36)];

let admin: postgres.Sql | undefined;
let database: Db;
let available = true;
let scanId: string;

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
  Object.assign(process.env, { DATABASE_URL: url.toString(), GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "unused", GITHUB_WEBHOOK_SECRET: "unused", SANDCHEST_APP_URL: "https://sandchest.test", SANDCHEST_ADMIN_TOKEN: TOKEN });
  resetConfig();
  database = createDb(url.toString(), { max: 2 });
  await migrate(database);
  setDb(database);
  const { org, repos } = await upsertInstallation(database, 701, { githubAccountId: 7100, githubLogin: "acme", type: "Organization" }, [{ githubRepoId: 71, fullName: "acme/app", private: true, defaultBranch: "main" }]);
  const [scan] = await database.insert(schema.scans).values({ repoId: repos[0]!.id, orgId: org.id, kind: "deep", trigger: "manual", headSha: "deadbeef", status: "completed" }).returning();
  scanId = scan!.id;
});

afterAll(async () => {
  delete process.env.SANDCHEST_ADMIN_TOKEN;
  resetConfig();
  if (!available) return;
  await database.$client.end();
  await admin!.unsafe(`drop database if exists ${NAME} with (force)`);
  await admin!.end();
});

const asOperator = (id: string) => events(new Request(`https://sandchest.test/api/scans/${id}/events`, { headers: { authorization: `Bearer ${TOKEN}` } }), { params: Promise.resolve({ id }) });

describe("dashboard filters", () => {
  test("drop a repo that isn't a UUID, and keep one that is", () => {
    for (const repo of MALFORMED) {
      expect(parseScans({ repo }).repo).toBeUndefined();
      expect(parseFindings({ repo }).repo).toBeUndefined();
    }
    expect(parseScans({ repo: REAL }).repo).toBe(REAL);
    expect(parseFindings({ repo: REAL }).repo).toBe(REAL);
  });
});

describe("id checks", () => {
  test("every page and route checks ids with the one UUID test, not a loose character class", () => {
    const loose: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name) && /\/\^\[0-9a-f-\]\{36\}\$\/\.test\(/.test(readFileSync(path, "utf8"))) loose.push(path);
      }
    };
    walk(join(import.meta.dir, "../src"));
    expect(loose).toEqual([]);
  });
});

describe.skipIf(!available)("scan events", () => {
  test("a malformed 36-character id is the same 404 as an unknown scan, never a 500", async () => {
    for (const id of MALFORMED) {
      const response = await asOperator(id);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not found" });
    }
    const unknown = await asOperator(REAL);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "not found" });
  });

  test("a real scan still streams its events", async () => {
    const response = await asOperator(scanId);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const body = await response.text();
    expect(body).toContain("event: status");
    expect(body).toContain("event: end");
  });
});
