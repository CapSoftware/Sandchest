/**
 * Billing frozen for the credit unit switch (SANDCHEST_BILLING_FREEZE=1), with Autumn and GitHub faked: every
 * surface that moves money or credits refuses with one message and sends Autumn nothing, no new credits are held
 * (a Dig or a dashboard review is refused, a PR review's scan waits and then goes ahead by itself), free scans and
 * scans already holding credits carry on, and the stored billing copy is left as it was. Unfrozen, the same calls
 * go through. The DB-backed half skips without Postgres.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { createDb, heldCreditScans, orgBillingRow, scanById, upsertInstallation, type Db } from "@sandchest/db";
import { migrate } from "@sandchest/db/migrate";
import type { GitHubApp } from "@sandchest/github";
import { ApiError } from "@/server/agent/errors";
import { billingOps } from "@/server/agent/ops/billing";
import { addCredits, confirmPurchase, purchase, quoteCredits, saveAutoTopUp } from "@/server/billing-actions";
import { BILLING_FROZEN, billingFrozen, reserveScan, setAutumn, setBillingFrozen, syncBilling } from "@/server/billing";
import { requestDeepScan } from "@/server/dig";
import { claimFreeCredits } from "@/server/free-credits";
import { quotePrReview, startPrReview } from "@/server/pr-review";
import { checkDiscount, completePayment, preparePayment, recruit } from "@/server/recruit-actions";
import { beginScan, FROZEN_WAIT, publishScan } from "@/server/scans";
import { runSchedules } from "@/server/schedule";
import { resetConfig } from "@/server/config";
import { setServices } from "@/server/services";
import { setScanStarter } from "@/server/start";
import { handleWebhook } from "@/server/webhooks";
import { FakeAutumn } from "./fake-autumn";

const ORG = "00000000-0000-4000-8000-0000000000f1";

afterEach(() => setBillingFrozen(undefined));

describe("frozen, every surface that moves money or credits refuses before reaching Autumn", () => {
  const autumn = new FakeAutumn("standard");
  beforeAll(() => setAutumn(autumn));
  afterAll(() => setAutumn(undefined));
  const form = (entries: Record<string, string>) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(entries)) data.set(key, value);
    return data;
  };

  test("the dashboard's purchases, the add-credits dialog and auto top-up", async () => {
    setBillingFrozen(true);
    expect(await purchase(ORG, {}, form({ kind: "top_up", credits: "25" }))).toEqual({ error: BILLING_FROZEN });
    expect(await confirmPurchase(ORG, {}, form({ kind: "top_up", credits: "25", purchase: crypto.randomUUID() }))).toEqual({ error: BILLING_FROZEN });
    expect(await quoteCredits(ORG, 25)).toEqual({ error: BILLING_FROZEN });
    expect(await addCredits(ORG, 25, crypto.randomUUID())).toEqual({ error: BILLING_FROZEN });
    expect(await saveAutoTopUp(ORG, {}, form({ enabled: "on", quantity: "10" }))).toEqual({ error: BILLING_FROZEN });
    expect(autumn.calls).toEqual([]);
  });

  test("joining while recruiting, paying on the page, codes, and free credits", async () => {
    setBillingFrozen(true);
    expect(await recruit(ORG, {}, form({ claim: "1" }))).toEqual({ error: BILLING_FROZEN });
    expect(await recruit(ORG, {}, form({ order: JSON.stringify({ credits: 10, autoTopUp: true }) }))).toEqual({ error: BILLING_FROZEN });
    expect(await preparePayment(ORG, {} as never)).toEqual({ error: BILLING_FROZEN });
    expect(await checkDiscount(ORG, "SPRING", { credits: 10, autoTopUp: true })).toEqual({ error: BILLING_FROZEN });
    expect(await completePayment(ORG, { credits: 10, autoTopUp: true }, "seti_1", {} as never)).toEqual({ error: BILLING_FROZEN });
    expect(await claimFreeCredits({ id: crypto.randomUUID(), githubUserId: 1 }, ORG)).toEqual({ ok: false, reason: "frozen" });
    expect(autumn.calls).toEqual([]);
  });

  test("the agent API's purchases, quotes, claims and auto top-up", async () => {
    setBillingFrozen(true);
    const op = (name: string) => billingOps.find((o) => o.name === name)!;
    const inputs: Record<string, unknown> = {
      buy_credits: { account: "acme", credits: 10 },
      quote_credits: { account: "acme", credits: 10 },
      claim_free_credits: { account: "acme" },
      set_auto_top_up: { account: "acme", enabled: true },
    };
    for (const [name, input] of Object.entries(inputs)) {
      const error = await (op(name).run as (context: unknown, input: unknown) => Promise<unknown>)({}, input).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 503, code: "billing_frozen", message: BILLING_FROZEN });
    }
    expect(autumn.calls).toEqual([]);
  });

  test("no credits are held, and nothing is held for a scan that costs nothing either", async () => {
    setBillingFrozen(true);
    expect(await reserveScan("00000000-0000-4000-8000-0000000000a1", { id: ORG, githubLogin: "acme" }, 5, false)).toEqual({ ok: false, reason: "frozen", credits: 5 });
    expect(autumn.calls).toEqual([]);
  });

  test("off unless SANDCHEST_BILLING_FREEZE is 1, and always off with billing off", () => {
    setBillingFrozen(false);
    expect(billingFrozen()).toBe(false);
    setBillingFrozen(true);
    setAutumn(undefined);
    expect(billingFrozen()).toBe(false);
    setAutumn(autumn);
  });
});

// ---- Against Postgres ---------------------------------------------------------

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest";
const NAME = `sandchest_billing_freeze_test_${process.pid}`;
let admin: postgres.Sql | undefined;
let database: Db;
let available = true;
const autumn = new FakeAutumn();
const started: string[] = [];
/** The PR's changed files: one security-relevant file (1 credit), or docs only (free). */
let changed: Array<{ filename: string; status: string; additions: number; deletions: number; patch?: string }> = [];
const relevant = [{ filename: "src/app.js", status: "modified", additions: 8, deletions: 4, patch: "@@ -1 +1 @@\n-a\n+b" }];
const fakeGithub = {
  installation: () => ({
    repositories: async () => [{ id: 61, full_name: "acme/api", private: true, default_branch: "main" }],
    pullFiles: async () => changed,
    pull: async (_repo: string, number: number) => ({ number, state: "open", head: { sha: `head${number}` }, base: { sha: "base" } }),
    createCheckRun: async () => 1,
    completeCheckRun: async () => {},
    createReview: async () => {},
    comment: async () => 1,
    editComment: async () => {},
    branchSha: async () => "deadbeef",
  }),
} as unknown as GitHubApp;
let acme: { id: string; githubLogin: string };

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
  Object.assign(process.env, { DATABASE_URL: url.toString(), GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "unused", GITHUB_WEBHOOK_SECRET: "unused", SANDCHEST_APP_URL: "https://sandchest.test" });
  resetConfig();
  database = createDb(url.toString(), { max: 5 });
  await migrate(database);
  setServices({ db: database, github: fakeGithub });
  setScanStarter(async (id) => void started.push(id));
});

afterAll(async () => {
  setAutumn(undefined);
  setScanStarter(undefined);
  if (!available) return;
  await database.$client.end();
  await admin!.unsafe(`drop database if exists ${NAME} with (force)`);
  await admin!.end();
});

const it = (name: string, fn: () => Promise<void>) => test(name, async () => (available ? fn() : console.warn(`skipped (no Postgres): ${name}`)));

describe("frozen scans and billing, against Postgres", () => {
  const deps = () => ({ db: database, github: fakeGithub, startScan: async (id: string) => void started.push(id), canScan: async () => true });
  const openPr = async (number: number) =>
    (
      await handleWebhook(deps(), "pull_request", `pr-${number}`, {
        action: "opened",
        number,
        installation: { id: 601 },
        repository: { id: 61, full_name: "acme/api", private: true, default_branch: "main" },
        sender: { login: "dev" },
        pull_request: { number, draft: false, head: { sha: `head${number}`, ref: "f", repo: { id: 61, full_name: "acme/api" } }, base: { sha: "base", ref: "main", repo: { id: 61 } }, author_association: "MEMBER" },
      })
    ).scans![0]!;
  const feed = async (scanId: string) => (await database.$client<Array<{ message: string }>>`select message from scan_events where scan_id = ${scanId} order by seq`).map((e) => e.message);
  const repo = async () => (await database.query.repos.findFirst({ where: (r, { eq }) => eq(r.orgId, acme.id), with: { org: true } }))!;

  it("set up: an org on Standard with 40 credits", async () => {
    setAutumn(autumn);
    const { org } = await upsertInstallation(database, 601, { githubAccountId: 600, githubLogin: "acme", type: "Organization" }, [{ githubRepoId: 61, fullName: "acme/api", private: true, defaultBranch: "main" }]);
    acme = { id: org.id, githubLogin: "acme" };
    await autumn.attach({ customerId: acme.id, planId: "standard", successUrl: "" });
    autumn.get(acme.id).credits = 40;
    await syncBilling(acme);
    expect((await orgBillingRow(database, acme.id))?.credits).toBe(40);
  });

  it("a webhook PR review waits with one note, holding nothing, and goes ahead by itself once thawed", async () => {
    changed = relevant;
    const scanId = await openPr(1);
    setBillingFrozen(true);
    const calls = autumn.calls.length;
    expect(await beginScan(scanId)).toEqual({ state: "queued" });
    expect(await beginScan(scanId)).toEqual({ state: "queued" });
    expect(await scanById(database, scanId)).toMatchObject({ status: "queued", billing: null, creditsReserved: null });
    expect((await feed(scanId)).filter((m) => m === FROZEN_WAIT)).toHaveLength(1);
    expect(autumn.calls.slice(calls)).toEqual([]);
    expect(await heldCreditScans(database)).toBe(0);

    setBillingFrozen(false);
    expect((await beginScan(scanId)).state).toBe("running");
    expect(await scanById(database, scanId)).toMatchObject({ billing: "reserved", creditsReserved: 1 });
    expect(autumn.get(acme.id).credits).toBe(39);
  });

  it("a scan already holding credits settles as usual while frozen, and a free review runs", async () => {
    const held = (await database.query.scans.findFirst({ where: (s, { eq }) => eq(s.billing, "reserved") }))!;
    setBillingFrozen(true);
    await database.$client`update scans set credits = 1, stats = ${JSON.stringify({ findingIds: [] })}::jsonb where id = ${held.id}`;
    await publishScan(held.id);
    expect(await scanById(database, held.id)).toMatchObject({ status: "completed", billing: "charged", credits: 1 });
    expect(autumn.get(acme.id).locks.size).toBe(0);
    expect(await heldCreditScans(database)).toBe(0);

    // Docs only: it costs nothing, so it holds nothing and runs.
    changed = [{ filename: "README.md", status: "modified", additions: 3, deletions: 0 }];
    const free = await openPr(2);
    expect((await beginScan(free)).state).toBe("running");
    // Marked reserved for 0 as every free scan is, which holds nothing and does not count as a hold.
    expect(await scanById(database, free)).toMatchObject({ billing: "reserved", creditsReserved: 0 });
    expect(await heldCreditScans(database)).toBe(0);
  });

  it("a Dig, a dashboard review and a scheduled deep scan hold nothing and leave no scan behind", async () => {
    setBillingFrozen(true);
    const before = (await database.query.scans.findMany()).length;
    const calls = autumn.calls.length;
    expect(await requestDeepScan({ ...(await repo()), loc: 50_000 })).toEqual({ ok: false, reason: "frozen" });
    changed = relevant;
    expect(await quotePrReview(await repo(), 3)).toEqual({ ok: false, reason: "frozen" });
    expect(await startPrReview(await repo(), 3, 1)).toEqual({ ok: false, reason: "frozen" });
    await database.$client`update repos set deep_scan_schedule = 'daily', next_deep_scan_at = now() - interval '1 minute' where org_id = ${acme.id}`;
    expect(await runSchedules()).toEqual({ due: 0, started: 0 });
    // Still due: it runs once thawed.
    expect((await repo()).nextDeepScanAt!.getTime()).toBeLessThan(Date.now());
    expect((await database.query.scans.findMany()).length).toBe(before);
    expect(autumn.calls.slice(calls)).toEqual([]);

    // Thawed, the same requests go through.
    setBillingFrozen(false);
    expect(await quotePrReview(await repo(), 3)).toMatchObject({ ok: true, credits: 1 });
    expect(await requestDeepScan({ ...(await repo()), loc: 50_000 })).toMatchObject({ ok: true });
  });

  it("the stored billing copy is neither refreshed nor written while frozen", async () => {
    const stored = (await orgBillingRow(database, acme.id))!;
    autumn.get(acme.id).credits = 7_000;
    setBillingFrozen(true);
    expect((await syncBilling(acme)).credits).toBe(stored.credits);
    // A free scan's credit check reads Autumn but stores nothing.
    expect(await reserveScan("00000000-0000-4000-8000-0000000000a2", acme, 0, false)).toEqual({ ok: true });
    expect((await orgBillingRow(database, acme.id))!.credits).toBe(stored.credits);
    setBillingFrozen(false);
    expect((await syncBilling(acme)).credits).toBe(7_000);
  });
});
