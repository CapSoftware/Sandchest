/**
 * What customers see of usage billing, against a real Postgres (local docker) with GitHub and Autumn faked: the
 * agent API's bill on a scan and its prices, the fast option only where it is offered (a forged request refused),
 * and quotes "up to" the hold for usage, the tier price in shadow, and exactly as before otherwise. Every
 * multiplier, ceiling and amount here is made up. Skips without Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { createDb, dashboardRepos, repoForUser, scanById, schema, upsertInstallation, type Db, type ScanBillLine, type ScanPricing } from "@sandchest/db";
import { migrate } from "@sandchest/db/migrate";
import type { GitHubApp } from "@sandchest/github";
import { billView } from "@/lib/bill-view";
import { issueKey } from "@/server/agent/tokens";
import { handleRest } from "@/server/agent/rest";
import { billApiView } from "@/server/agent/views";
import { setAutumn } from "@/server/billing";
import { resetConfig } from "@/server/config";
import { requestDeepScan } from "@/server/dig";
import { orgPlans } from "@/server/org-plans";
import { quotePrReview } from "@/server/pr-review";
import { setServices } from "@/server/services";
import { setScanStarter } from "@/server/start";
import { FakeAutumn } from "./fake-autumn";

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest";
const NAME = `sandchest_usage_ui_test_${process.pid}`;
const BASE = "https://sandchest.test";

const BASE_ENV = { GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "unused", GITHUB_WEBHOOK_SECRET: "unused", SANDCHEST_APP_URL: BASE };
const SLICE_ENV = {
  SANDCHEST_ENGINE: "slice",
  SANDCHEST_WORKSPACE: "boat",
  SANDCHEST_BOAT_API_KEY: "boat_test",
  SANDCHEST_INDEXER_LINUX_BIN: "/opt/sandchest-index",
  SANDCHEST_GATEWAY_SECRET: "gateway-secret-0123456789abcdef-xyz",
  SANDCHEST_SLICE_CEILING_USD: "0.5",
  SANDCHEST_SLICE_CEILING_PR_USD: "0.25",
};
const FAST_ENV = { SANDCHEST_SLICE_CEILING_FAST_USD: "1.5", LLM_AGENT_FAST_MODEL: "fast-model" };
/** A made-up multiplier of 3, credits worth a cent: a deep scan holds 150, a fast one 450, a review 75. */
const USAGE_ENV = { SANDCHEST_USAGE_BILLING: "on", SANDCHEST_USAGE_MULTIPLIER: "3", NEXT_PUBLIC_SANDCHEST_CREDIT_UNIT: "cent" };
const SHADOW_ENV = { SANDCHEST_USAGE_BILLING: "shadow", SANDCHEST_USAGE_MULTIPLIER: "3" };
const SETTINGS = [...new Set([...Object.keys(BASE_ENV), ...Object.keys(SLICE_ENV), ...Object.keys(FAST_ENV), ...Object.keys(USAGE_ENV), "SANDCHEST_ENGINE_ORGS", "DATABASE_URL", "GITHUB_APP_SLUG"])];

let admin: postgres.Sql | undefined;
let database: Db;
let available = true;
let databaseUrl = "";
const autumn = new FakeAutumn("chest");
const started: string[] = [];
const saved: Record<string, string | undefined> = {};
let ids: { org: string; repo: string; user: string };
let key = "";

const fakeGithub = {
  installation: () => ({
    branchSha: async () => "sha1",
    pull: async () => ({ state: "open", head: { sha: "head1" }, base: { sha: "base1" } }),
    pullFiles: async () => [{ filename: "src/auth/session.ts", status: "modified", additions: 12, deletions: 2, patch: "@@ -1,2 +1,12 @@\n+export const a = 1;" }],
  }),
} as unknown as GitHubApp;

/** Runs `fn` with exactly these settings on top of the base ones, then puts every setting back as the test found it. */
async function withSettings<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  for (const name of SETTINGS) delete process.env[name];
  Object.assign(process.env, BASE_ENV, { DATABASE_URL: databaseUrl }, env);
  resetConfig();
  try {
    return await fn();
  } finally {
    for (const name of SETTINGS) delete process.env[name];
    Object.assign(process.env, BASE_ENV, { DATABASE_URL: databaseUrl });
    resetConfig();
  }
}

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
  databaseUrl = url.toString();
  for (const name of SETTINGS) saved[name] = process.env[name];
  for (const name of SETTINGS) delete process.env[name];
  Object.assign(process.env, BASE_ENV, { DATABASE_URL: databaseUrl });
  resetConfig();
  database = createDb(databaseUrl, { max: 5 });
  await migrate(database);
  setServices({ db: database, github: fakeGithub });
  setAutumn(autumn);
  setScanStarter(async (id) => void started.push(id));

  const { org, repos } = await upsertInstallation(database, 4401, { githubAccountId: 4401, githubLogin: "acme", type: "Organization" }, [{ githubRepoId: 4401, fullName: "acme/app", private: true, defaultBranch: "main" }]);
  await database.$client`update repos set loc = 50000 where id = ${repos[0]!.id}`;
  const [user] = await database.insert(schema.users).values({ name: "Pat", email: "pat@example.com", login: "pat", githubUserId: 4401, accessCheckedAt: new Date(Date.now() + 86_400_000) }).returning();
  await database.insert(schema.orgAdmins).values({ userId: user!.id, orgId: org.id });
  await database.insert(schema.permissionCache).values({ userId: user!.id, repoId: repos[0]!.id, permission: "admin" });
  ids = { org: org.id, repo: repos[0]!.id, user: user!.id };
  key = (await issueKey(user!.id, "Test agent")).key;
  autumn.get(org.id).credits = 100_000;
});

afterAll(async () => {
  setAutumn(undefined);
  setScanStarter(undefined);
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetConfig();
  if (!available || !admin) return;
  await database.$client.end();
  await admin.unsafe(`drop database if exists ${NAME} with (force)`);
  await admin.end();
});

const it = (name: string, fn: () => Promise<void>) => test(name, async () => (available ? fn() : console.warn(`skipped (no Postgres): ${name}`)));

/** Calls the REST API the way an agent would. */
async function api(method: string, path: string, body?: unknown) {
  const url = new URL(`${BASE}/api/v1${path}`);
  const request = new Request(url, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body !== undefined && { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await handleRest(request, url.pathname.replace(/^\/api\/v1\/?/, "").split("/").filter(Boolean));
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

/** Clears the repo's deep scans (and their bills), so the next one can start. */
async function noScans(): Promise<void> {
  await database.$client`delete from scan_bills where org_id = ${ids.org}`;
  await database.$client`delete from scans where repo_id = ${ids.repo}`;
}

const USAGE: ScanPricing = { engine: "slice", mode: "usage", unit: "cent", multiplierThousandths: 3_000, ceilingMicroUsd: 500_000 };

/** A finished scan of the repo, priced as given, with a bill in `status` when one is given. */
async function finishedScan(pricing: ScanPricing | null, bill?: "open" | "charged" | "waived" | "voided" | "shadow"): Promise<string> {
  const [scan] = await database
    .insert(schema.scans)
    .values({ repoId: ids.repo, orgId: ids.org, kind: "pr_review", prNumber: 7, status: "completed", trigger: "webhook", headSha: `h${Math.random()}`, credits: 3, billing: "charged", pricing })
    .returning();
  if (bill) {
    const lines: ScanBillLine[] = [
      { kind: "model", stage: "slice_hunt", requests: 4, inputTokens: 8_000, cachedTokens: 0, outputTokens: 900, reasoningTokens: 0, seconds: 0, costMicroUsd: 9_000, chargeMicroUsd: 27_000 },
      { kind: "sandbox", stage: "sandbox", requests: 1, inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0, seconds: 30.5, costMicroUsd: 1_100, chargeMicroUsd: 3_300 },
    ];
    const waived = bill === "waived";
    await database.insert(schema.scanBills).values({
      scanId: scan!.id,
      orgId: ids.org,
      status: bill,
      engine: "slice",
      multiplierThousandths: 3_000,
      creditMicroUsd: 10_000,
      costMicroUsd: 10_100,
      dueMicroUsd: 30_300,
      reservedCredits: 75,
      credits: waived ? 0 : 3,
      carryInMicroUsd: 400,
      carryOutMicroUsd: waived ? 400 : 700,
      capped: false,
      lines,
    });
  }
  return scan!.id;
}

const SCAN_KEYS = ["id", "kind", "status", "done", "trigger", "pr_number", "commit", "repo", "created_at", "started_at", "finished_at", "duration_ms", "credits", "lines_of_code", "error", "findings", "url"];

describe("get_scan's bill", () => {
  it("a scan with no customer-visible bill answers exactly as before: same keys, same order, no bill", async () => {
    for (const [pricing, bill] of [
      [null, undefined],
      [{ engine: "slice", mode: "tiered", unit: "dollar" }, undefined],
      [{ ...USAGE, mode: "shadow" }, "shadow"],
      [USAGE, undefined],
      [USAGE, "voided"],
      [USAGE, "shadow"],
    ] as const) {
      const scanId = await finishedScan(pricing as ScanPricing | null, bill);
      const response = await api("GET", `/scans/${scanId}`);
      expect(response.status).toBe(200);
      expect(Object.keys(response.body)).toEqual(SCAN_KEYS);
      expect(response.body.credits).toEqual({ held: 0, charged: 3 });
    }
  });

  it("an open, charged or waived bill of a usage scan is itemised in credits, the same as the page", async () => {
    for (const status of ["open", "charged", "waived"] as const) {
      const scanId = await finishedScan(USAGE, status);
      const response = await api("GET", `/scans/${scanId}`);
      expect(Object.keys(response.body)).toEqual([...SCAN_KEYS, "bill"]);
      const stored = (await database.query.scanBills.findFirst({ where: (bills, { eq }) => eq(bills.scanId, scanId) }))!;
      expect(response.body.bill).toEqual(billApiView(billView(stored)!));
      expect(response.body.bill).toMatchObject({
        status,
        lines: [
          { label: "Hunting", calls: 4, input_tokens: 8_000, output_tokens: 900, credits: 2.7 },
          { label: "Sandbox time", sandbox_seconds: 30.5, credits: 0.33 },
        ],
        usage: 3.03,
        charged: status === "waived" ? 0 : 3,
        carried_out: status === "waived" ? 0.04 : 0.07,
        capped: false,
        fast: false,
        held: 75,
      });
      expect(JSON.stringify(response.body.bill)).not.toMatch(/cost|multiplier|micro|usd/i);
    }
  });
});

describe("prices before a scan", () => {
  it("tiered: the repo's price is exactly as before", async () => {
    await withSettings(SLICE_ENV, async () => {
      const repo = (await api("GET", "/repos/acme/app")).body;
      expect(repo.deep_scan).toEqual({ credits: 500, held_until_sized: null, too_large: false });
      const listed = (await api("GET", "/repos")).body.repos[0];
      expect(listed.deep_scan).toEqual({ credits: 500, held_until_sized: null, too_large: false });
      const [row] = await dashboardRepos(database, ids.user);
      expect((await orgPlans([row!])).get(ids.org)).toEqual({ planId: "chest", credits: expect.any(Number) });
    });
  });

  it("shadow: quoted the tier price, which is what is charged", async () => {
    await withSettings({ ...SLICE_ENV, ...FAST_ENV, ...SHADOW_ENV }, async () => {
      expect((await api("GET", "/repos/acme/app")).body.deep_scan).toEqual({ credits: 500, held_until_sized: null, too_large: false });
      const [row] = await dashboardRepos(database, ids.user);
      expect("usage" in (await orgPlans([row!])).get(ids.org)!).toBe(false);
      const quote = await quotePrReview({ ...(await repoForUser(database, ids.user, ids.repo))!.repo, org: (await repoForUser(database, ids.user, ids.repo))!.org }, 7);
      expect(quote).toEqual({ ok: true, scanId: "", credits: 100 });
    });
  });

  it("usage: up to the hold, with fast and its maximum where it is offered", async () => {
    await withSettings({ ...SLICE_ENV, ...USAGE_ENV }, async () => {
      expect((await api("GET", "/repos/acme/app")).body.deep_scan).toEqual({ credits: null, held_until_sized: null, too_large: false, up_to_credits: 150, fast: { available: false } });
      const row = (await repoForUser(database, ids.user, ids.repo))!;
      expect(await quotePrReview({ ...row.repo, org: row.org }, 7)).toEqual({ ok: true, scanId: "", credits: 75, upTo: true });
    });
    await withSettings({ ...SLICE_ENV, ...FAST_ENV, ...USAGE_ENV }, async () => {
      expect((await api("GET", "/repos")).body.repos[0].deep_scan).toEqual({ credits: null, held_until_sized: null, too_large: false, up_to_credits: 150, fast: { available: true, up_to_credits: 450 } });
      const [repo] = await dashboardRepos(database, ids.user);
      expect((await orgPlans([repo!])).get(ids.org)).toMatchObject({ planId: "chest", usage: { hold: 150, fast: 450 } });
    });
  });
});

describe("start_deep_scan and fast", () => {
  it("tiered: started as before, the same message, never fast", async () => {
    await noScans();
    await withSettings(SLICE_ENV, async () => {
      const response = await api("POST", "/repos/acme/app/scans");
      expect(response.status).toBe(202);
      expect(response.body.message).toBe("Started. Call get_scan with wait=50 to follow it until it's done.");
      const scan = (await scanById(database, response.body.scan.id))!;
      expect(scan).toMatchObject({ fast: false, creditsReserved: 500, pricing: { engine: "slice", mode: "tiered" } });
    });
  });

  it("shadow: holds the tier price; fast is refused", async () => {
    await noScans();
    await withSettings({ ...SLICE_ENV, ...FAST_ENV, ...SHADOW_ENV }, async () => {
      const refused = await api("POST", "/repos/acme/app/scans", { fast: true });
      expect(refused.status).toBe(422);
      expect(refused.body.error.code).toBe("fast_unavailable");
      const response = await api("POST", "/repos/acme/app/scans");
      expect(response.body.message).toBe("Started. Call get_scan with wait=50 to follow it until it's done.");
      expect((await scanById(database, response.body.scan.id))!).toMatchObject({ fast: false, creditsReserved: 500, pricing: { mode: "shadow" } });
    });
  });

  it("a forged fast request is refused wherever it is not offered, and leaves nothing behind", async () => {
    for (const env of [SLICE_ENV, { ...SLICE_ENV, ...FAST_ENV }, { ...SLICE_ENV, ...USAGE_ENV }, { ...SLICE_ENV, ...FAST_ENV, ...USAGE_ENV, SANDCHEST_ENGINE_ORGS: "someone-else" }]) {
      await noScans();
      await withSettings(env, async () => {
        const reserves = autumn.calls.filter((call) => call === "reserve").length;
        const refused = await api("POST", "/repos/acme/app/scans", { fast: true });
        expect(refused.status).toBe(422);
        expect(refused.body.error).toEqual({ code: "fast_unavailable", message: "Fast deep scans aren't available for acme. Start it without fast.", account: "acme" });
        expect(await database.$client`select id from scans where repo_id = ${ids.repo}`).toHaveLength(0);
        expect(autumn.calls.filter((call) => call === "reserve").length).toBe(reserves);
        // The dashboard's action asks the same function, so it is refused there too.
        const row = (await repoForUser(database, ids.user, ids.repo))!;
        expect(await requestDeepScan({ ...row.repo, org: row.org }, "manual", { fast: true })).toEqual({ ok: false, reason: "fast_unavailable" });
      });
    }
  });

  it("usage: holds up to the hold, says so, and fast where offered holds the fast maximum; a scheduled scan is never fast", async () => {
    await noScans();
    await withSettings({ ...SLICE_ENV, ...FAST_ENV, ...USAGE_ENV }, async () => {
      const standard = await api("POST", "/repos/acme/app/scans");
      expect(standard.status).toBe(202);
      expect(standard.body.message).toBe("Started, holding up to 150 credits: it's charged what it uses, never more. Call get_scan with wait=50 to follow it until it's done.");
      expect(standard.body.scan.credits).toEqual({ held: 150, charged: 0 });
      expect((await scanById(database, standard.body.scan.id))!).toMatchObject({ fast: false, creditsReserved: 150, pricing: { mode: "usage", fast: false } });

      await noScans();
      const fast = await api("POST", "/repos/acme/app/scans", { fast: true });
      expect(fast.status).toBe(202);
      expect(fast.body.message).toStartWith("Started, holding up to 450 credits");
      expect((await scanById(database, fast.body.scan.id))!).toMatchObject({ fast: true, creditsReserved: 450, pricing: { mode: "usage", fast: true, ceilingMicroUsd: 1_500_000 } });

      await noScans();
      const row = (await repoForUser(database, ids.user, ids.repo))!;
      expect(await requestDeepScan({ ...row.repo, org: row.org }, "schedule", { fast: true })).toEqual({ ok: false, reason: "fast_unavailable" });
      const scheduled = await requestDeepScan({ ...row.repo, org: row.org }, "schedule");
      expect(scheduled).toMatchObject({ ok: true, heldUpTo: 150 });
      expect((await scanById(database, (scheduled as { scanId: string }).scanId))!).toMatchObject({ fast: false, trigger: "schedule" });
    });
  });
});
