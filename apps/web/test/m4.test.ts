/**
 * Billing (SPEC §12) against a real Postgres, with GitHub and Autumn faked:
 * the paywall before recon, the credit gate on every scan, neutral Checks
 * when a PR is not reviewed, credits held and given back, Dig, the sweep and
 * auto top-up. The scan engine itself is not run here; m2 runs it end to end
 * with billing on.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { createDb, orgBillingRow, scanById, schema, upsertInstallation, type Db } from "@sandchest/db";
import { migrate } from "@sandchest/db/migrate";
import type { GitHubApp } from "@sandchest/github";
import { GET as sweep } from "@/app/api/cron/sweep/route";
import { applyAutoTopUp, buyCredits, canScan, hasPlan, reserveScan, setAutumn, settleScan, syncBilling } from "@/server/billing";
import { requestDeepScan } from "@/server/dig";
import { beginScan, failScan, publishScan } from "@/server/scans";
import { resetConfig } from "@/server/config";
import { setServices } from "@/server/services";
import { setRunStatus, setScanStarter } from "@/server/start";
import { handleWebhook } from "@/server/webhooks";
import { FakeAutumn } from "./fake-autumn";

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest";
const NAME = `sandchest_m4_test_${process.pid}`;

let admin: postgres.Sql | undefined;
let database: Db;
let available = true;

const checks: Array<{ repo: string; title: string; conclusion?: string; summary?: string }> = [];
const repoList = [
  { id: 41, full_name: "acme/api", private: true, default_branch: "main" },
  { id: 42, full_name: "acme/web", private: true, default_branch: "main" },
];
const fakeGithub = {
  installation: () => ({
    repositories: async () => repoList,
    // 12 changed lines in one security-relevant file, plus docs and a lockfile that cost nothing: 1 credit.
    pullFiles: async () => [
      { filename: "src/app.js", status: "modified", additions: 8, deletions: 4, patch: "@@ -1 +1 @@\n-a\n+b" },
      { filename: "README.md", status: "modified", additions: 400, deletions: 0 },
      { filename: "package-lock.json", status: "modified", additions: 900, deletions: 900 },
    ],
    createCheckRun: async (repo: string, input: { output: { title: string } }) => {
      checks.push({ repo, title: input.output.title });
      return checks.length;
    },
    completeCheckRun: async (repo: string, id: number, conclusion: string, output: { title: string; summary: string }) => {
      Object.assign(checks[id - 1]!, { conclusion, title: output.title, summary: output.summary });
    },
    createReview: async () => {},
    comment: async () => 1,
    editComment: async () => {},
    branchSha: async () => "deadbeef",
  }),
} as unknown as GitHubApp;

const autumn = new FakeAutumn();
const started: string[] = [];
// The workflow runs the sweep can see, by run id. Any other id is a run that does not exist.
const runs = new Map<string, string>();
const deps = () => ({ db: database, github: fakeGithub, startScan: async (id: string) => void started.push(id), canScan });
let acme: { id: string; githubLogin: string };
let repoIds: string[];

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
  Object.assign(process.env, { DATABASE_URL: url.toString(), GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "unused", GITHUB_WEBHOOK_SECRET: "unused", SANDCHEST_APP_URL: "https://sandchest.test", CRON_SECRET: "cron-secret" });
  resetConfig();
  database = createDb(url.toString(), { max: 5 });
  await migrate(database);
  // The sweep also syncs the CVE directory: OSV is stubbed so the cron never waits on the network.
  const noAdvisories = { matches: async (packages: unknown[]) => packages.map(() => []), record: async () => undefined, changedSince: async () => ({ changes: [], complete: true }) };
  setServices({ db: database, github: fakeGithub, catalog: noAdvisories });
  setAutumn(autumn);
  setScanStarter(async (id) => void started.push(id));
  setRunStatus(async (runId) => runs.get(runId));
});

afterAll(async () => {
  setAutumn(undefined);
  setScanStarter(undefined);
  setRunStatus(undefined);
  if (!available) return;
  await database.$client.end();
  await admin!.unsafe(`drop database if exists ${NAME} with (force)`);
  await admin!.end();
});

const prEvent = (repo: (typeof repoList)[number], number: number, head: string) => ({
  action: "opened",
  number,
  installation: { id: 501 },
  repository: repo,
  sender: { login: "dev" },
  pull_request: { number, draft: false, head: { sha: head, ref: "f", repo: { id: repo.id, full_name: repo.full_name } }, base: { sha: "base", ref: "main", repo: { id: repo.id } }, author_association: "MEMBER" },
});

async function openPr(number: number): Promise<string> {
  const outcome = await handleWebhook(deps(), "pull_request", `pr-${number}`, prEvent(repoList[0]!, number, `head${number}`));
  return outcome.scans![0]!;
}

describe.skipIf(!available)("billing", () => {
  test("install without a plan: recon waits, and buying a plan starts it once per repo", async () => {
    const outcome = await handleWebhook(deps(), "installation", "install-1", { action: "created", installation: { id: 501, account: { id: 900, login: "acme", type: "Organization" } } });
    expect(outcome).toMatchObject({ status: "handled", scans: [], detail: "recon waits for a plan and credits" });
    const org = await database.query.orgs.findFirst({ where: (orgs, { eq }) => eq(orgs.installationId, 501) });
    acme = { id: org!.id, githubLogin: "acme" };
    repoIds = (await database.query.repos.findMany({ where: (repos, { eq }) => eq(repos.orgId, acme.id) })).map((r) => r.id);
    expect((await orgBillingRow(database, acme.id))?.planId).toBeNull();

    // Checkout completes in Autumn; the return page (or any page) reads it.
    await autumn.attach({ customerId: acme.id, planId: "lockbox", successUrl: "" });
    const before = started.length;
    const [first, second] = await Promise.all([syncBilling(acme), syncBilling(acme)]);
    expect(first.planId).toBe("lockbox");
    expect(second.credits).toBe(6_000);
    expect(started.length - before).toBe(2);
    const recons = await database.query.scans.findMany({ where: (scans, { eq }) => eq(scans.orgId, acme.id) });
    expect(recons.map((s) => s.kind)).toEqual(["recon", "recon"]);
    expect((await orgBillingRow(database, acme.id))?.activatedAt).toBeInstanceOf(Date);

    // Later reads never queue them again.
    await syncBilling(acme);
    expect(started.length - before).toBe(2);
  });

  test("with a plan, a repo added later gets one recon, and a reinstall none twice", async () => {
    repoList.push({ id: 43, full_name: "acme/worker", private: true, default_branch: "main" });
    const added = await handleWebhook(deps(), "installation_repositories", "repos-added", {
      action: "added",
      installation: { id: 501 },
      repositories_added: [{ id: 43, full_name: "acme/worker" }],
      repositories_removed: [],
    });
    expect(added.scans).toHaveLength(1);
    // Every repo already has a recon on the way: reinstalling queues nothing more.
    const reinstalled = await handleWebhook(deps(), "installation", "install-2", { action: "created", installation: { id: 501, account: { id: 900, login: "acme", type: "Organization" } } });
    expect(reinstalled).toMatchObject({ status: "handled", scans: [] });
    const recons = await database.query.scans.findMany({ where: (scans, { and, eq }) => and(eq(scans.orgId, acme.id), eq(scans.kind, "recon")) });
    expect(recons).toHaveLength(3);
    repoList.pop();
  });

  test("a PR review holds what it will cost, and is charged it when it completes", async () => {
    const scanId = await openPr(1);
    expect((await beginScan(scanId)).state).toBe("running");
    expect(await scanById(database, scanId)).toMatchObject({ billing: "reserved", creditsReserved: 100 });
    expect(autumn.get(acme.id).credits).toBe(5_900);
    expect((await orgBillingRow(database, acme.id))?.credits).toBe(5_900);

    // A retried begin step neither reserves twice nor posts a second Check.
    const checkCount = checks.length;
    await beginScan(scanId);
    expect(checks.length).toBe(checkCount);
    expect(autumn.get(acme.id).credits).toBe(5_900);

    // The engine reported more than was shown up front: never charge more than was held.
    await database.$client`update scans set credits = 300, stats = ${JSON.stringify({ findingIds: [] })}::jsonb where id = ${scanId}`;
    await publishScan(scanId);
    expect(await scanById(database, scanId)).toMatchObject({ status: "completed", billing: "charged", credits: 100 });
    expect(autumn.get(acme.id).credits).toBe(5_900);
    expect(autumn.get(acme.id).locks.size).toBe(0);
    expect(checks.at(-1)).toMatchObject({ conclusion: "success" });
  });

  test("a scan that fails gives its credits back", async () => {
    const scanId = await openPr(2);
    await beginScan(scanId);
    expect(autumn.get(acme.id).credits).toBe(5_800);
    await failScan(scanId, "model provider down");
    expect(await scanById(database, scanId)).toMatchObject({ status: "failed", billing: "released", credits: 0 });
    expect(autumn.get(acme.id).credits).toBe(5_900);
    expect(checks.at(-1)).toMatchObject({ conclusion: "neutral", title: "Review could not finish" });
    // Failing again (a retried step) changes nothing.
    await failScan(scanId, "again");
    expect(autumn.get(acme.id).credits).toBe(5_900);
  });

  test("out of credits: a neutral Check that links to billing, and nothing held", async () => {
    autumn.get(acme.id).credits = 0;
    const scanId = await openPr(3);
    expect((await beginScan(scanId)).state).toBe("done");
    expect(await scanById(database, scanId)).toMatchObject({ status: "refused", billing: null });
    expect(checks.at(-1)).toMatchObject({ conclusion: "neutral", title: "Out of credits" });
    expect(checks.at(-1)!.summary).toContain("needs 100 credits");
    expect(checks.at(-1)!.summary).toContain("https://sandchest.test/dashboard/settings");
    expect(autumn.get(acme.id).locks.size).toBe(0);
    // The refusal also refreshed what the dashboard shows.
    expect((await orgBillingRow(database, acme.id))?.credits).toBe(0);
  });

  test("a PR refused for credits isn't reviewed again on every push, until the org can pay", async () => {
    const push = (head: string) => handleWebhook(deps(), "pull_request", `pr-3-${head}`, { ...prEvent(repoList[0]!, 3, head), action: "synchronize" });
    expect(await push("head3b")).toMatchObject({ status: "ignored", detail: expect.stringContaining("already refused") });
    // Credits bought: the next push is reviewed.
    autumn.get(acme.id).credits = 500;
    await syncBilling(acme);
    expect(await push("head3c")).toMatchObject({ status: "handled" });
    autumn.get(acme.id).credits = 0;
    await syncBilling(acme);
  });

  test("a fix check still runs with no credits left: it costs none, and closing a fixed bug never waits on a top-up", async () => {
    expect(autumn.get(acme.id).credits).toBe(0);
    expect(await reserveScan("00000000-0000-4000-8000-00000000f1c0", acme, 0, false)).toEqual({ ok: false, reason: "out_of_credits", credits: 0 });
    expect(await reserveScan("00000000-0000-4000-8000-00000000f1c1", acme, 0, false, { evenWhenEmpty: true })).toEqual({ ok: true });
  });

  test("out of credits while Autumn can't be read: still 'out of credits', not 'no plan'", async () => {
    // Before, a failed re-read after a refusal was taken to mean the org had no plan.
    autumn.failNext.add("customer");
    expect(await reserveScan("00000000-0000-4000-8000-00000000f00d", acme, 100, false)).toEqual({ ok: false, reason: "out_of_credits", credits: 100 });
    expect(autumn.failNext.size).toBe(0);
  });

  test("credits added where they ran short: charged once on a paid plan however often it's sent; without one, Stripe joins the plan", async () => {
    const customer = autumn.get(acme.id);
    const before = { planId: customer.planId, credits: customer.credits, card: customer.card };
    try {
      Object.assign(customer, { planId: "standard", card: true, credits: 300 });
      const purchase = crypto.randomUUID();
      expect(await buyCredits(acme, 2_500, purchase, "https://sandchest.test/return")).toMatchObject({ paymentUrl: null, joins: false, credits: 2_800 });
      // Pressed again, or retried after a timeout: the same purchase, charged once.
      expect(await buyCredits(acme, 2_500, purchase, "https://sandchest.test/return")).toMatchObject({ paymentUrl: null, repeated: true });
      expect(customer.credits).toBe(2_800);
      // A new opening of the dialog is a new purchase.
      expect(await buyCredits(acme, 1_000, crypto.randomUUID(), "https://sandchest.test/return")).toMatchObject({ credits: 3_800 });

      // Free credits only: buying more joins the plan with them, on Stripe.
      Object.assign(customer, { planId: "trial", card: false, credits: 300 });
      const joined = await buyCredits(acme, 2_500, crypto.randomUUID(), "https://sandchest.test/return");
      expect(joined.joins).toBe(true);
      expect(joined.paymentUrl).toBeTruthy();
    } finally {
      Object.assign(customer, before);
      await syncBilling(acme);
    }
  });

  test("an org's first Dig is paid like any other: without the credits it holds, nothing runs and no scan is left", async () => {
    for (const credits of [0, 100]) {
      autumn.get(acme.id).credits = credits;
      const repo = await database.query.repos.findFirst({ where: (repos, { eq }) => eq(repos.id, repoIds[0]!), with: { org: true } });
      expect(repo!.lastDeepScanAt).toBeNull();
      const before = (await database.query.scans.findMany()).length;
      // Not sized yet: it holds the top tier, 2,500, first Dig or not.
      expect(await requestDeepScan(repo!)).toEqual({ ok: false, reason: "out_of_credits", credits: 2_500 });
      expect((await database.query.scans.findMany()).length).toBe(before);
      expect(autumn.get(acme.id).credits).toBe(credits);
    }
    autumn.get(acme.id).credits = 0;
  });

  test("Dig: refused without credits leaves no scan; with credits it holds the cost shown", async () => {
    const repo = await database.query.repos.findFirst({ where: (repos, { eq }) => eq(repos.id, repoIds[0]!), with: { org: true } });
    const before = (await database.query.scans.findMany()).length;
    // Not sized yet: a Dig holds the top tier, 2,500.
    expect(await requestDeepScan(repo!)).toEqual({ ok: false, reason: "out_of_credits", credits: 2_500 });
    expect((await database.query.scans.findMany()).length).toBe(before);

    // Credits bought with the card on file.
    await autumn.attach({ customerId: acme.id, planId: "top_up", credits: 2_500, successUrl: "" });
    const result = await requestDeepScan({ ...repo!, loc: 50_000 });
    expect(result.ok).toBe(true);
    const scan = await scanById(database, (result as { scanId: string }).scanId);
    expect(scan).toMatchObject({ kind: "deep", billing: "reserved", creditsReserved: 500 });
    expect(autumn.get(acme.id).credits).toBe(2_000);
    expect(started).toContain(scan!.id);
  });

  test("the sweep settles what finished scans still hold", async () => {
    autumn.get(acme.id).credits = 4_000;
    const ids: string[] = [];
    for (const status of ["failed", "completed"] as const) {
      const [scan] = await database.insert(schema.scans).values({ repoId: repoIds[1]!, orgId: acme.id, kind: "deep", trigger: "manual", headSha: status }).returning();
      expect(await reserveScan(scan!.id, acme, 1_500)).toEqual({ ok: true });
      await database.$client`update scans set status = ${status}, credits = 1_500 where id = ${scan!.id}`;
      ids.push(scan!.id);
    }
    expect(autumn.get(acme.id).credits).toBe(1_000);
    const unauthorized = await sweep(new Request("https://sandchest.test/api/cron/sweep"));
    expect(unauthorized.status).toBe(401);
    const response = await sweep(new Request("https://sandchest.test/api/cron/sweep", { headers: { authorization: "Bearer cron-secret" } }));
    expect(await response.json()).toMatchObject({ settled: 2, errors: 0 });
    expect(await scanById(database, ids[0]!)).toMatchObject({ billing: "released", credits: 0 });
    expect(await scanById(database, ids[1]!)).toMatchObject({ billing: "charged", credits: 1_500 });
    expect(autumn.get(acme.id).credits).toBe(2_500);
  });

  test("the sweep restarts lost starts and fails stuck PR reviews, so no Check spins forever", async () => {
    // A scan whose workflow start was lost 10 minutes ago, and a PR review stuck for an hour with its Check in progress.
    checks.push({ repo: "acme/api", title: "Scanning…" });
    const stuckCheck = checks.length;
    const [lost] = await database
      .insert(schema.scans)
      .values({ repoId: repoIds[0]!, orgId: acme.id, kind: "recon", trigger: "webhook", headSha: "lost", createdAt: new Date(Date.now() - 10 * 60_000) })
      .returning();
    const [stuck] = await database
      .insert(schema.scans)
      .values({ repoId: repoIds[0]!, orgId: acme.id, kind: "pr_review", trigger: "webhook", headSha: "stuck", prNumber: 77, status: "running", checkRunId: stuckCheck, workflowRunId: "run-stuck", startedAt: new Date(Date.now() - 60 * 60_000) })
      .returning();
    started.length = 0;

    const response = await sweep(new Request("https://sandchest.test/api/cron/sweep", { headers: { authorization: "Bearer cron-secret" } }));
    expect(await response.json()).toMatchObject({ started: 1, failed: 1, errors: 0 });
    expect(started).toEqual([lost!.id]);
    expect(await scanById(database, stuck!.id)).toMatchObject({ status: "failed", error: "The scan stopped responding." });
    expect(checks[stuckCheck - 1]).toMatchObject({ conclusion: "neutral", title: "Review could not finish" });

    // A second sweep finds nothing new to do.
    await database.$client`update scans set workflow_run_id = 'run-lost' where id = ${lost!.id}`;
    const again = await sweep(new Request("https://sandchest.test/api/cron/sweep", { headers: { authorization: "Bearer cron-secret" } }));
    expect(await again.json()).toMatchObject({ started: 0, failed: 0 });
  });

  test("two Digs at once start one deep scan, and the other gives its credits back", async () => {
    autumn.get(acme.id).credits = 4_000;
    const repo = await database.query.repos.findFirst({ where: (repos, { eq }) => eq(repos.id, repoIds[1]!), with: { org: true } });
    started.length = 0;
    const results = await Promise.all([requestDeepScan({ ...repo!, loc: 50_000 }), requestDeepScan({ ...repo!, loc: 50_000 })]);
    const winners = results.filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    const winner = (winners[0] as { scanId: string }).scanId;
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, reason: "running", scanId: winner });
    expect(started).toEqual([winner]);
    const active = await database.$client<Array<{ n: number }>>`select count(*)::int as n from scans where repo_id = ${repoIds[1]!} and kind = 'deep' and status = 'queued'`;
    expect(active[0]!.n).toBe(1);
    // Only the winner's 500 credits stay held.
    expect(autumn.get(acme.id).credits).toBe(3_500);
  });

  test("a Dig that loses the race never reaches Autumn: no hold, no auto top-up", async () => {
    // Free the slot left by the previous test, then arm auto top-up below 500 credits.
    await database.$client`update scans set status = 'completed' where repo_id = ${repoIds[1]!} and kind = 'deep'`;
    const customer = autumn.get(acme.id);
    customer.credits = 1_200;
    customer.autoTopUp = { enabled: true, threshold: 500, quantity: 2_500, perMonth: 4 };
    customer.topUpsThisMonth = 0;
    const chargesBefore = customer.charges.length;
    const repo = await database.query.repos.findFirst({ where: (repos, { eq }) => eq(repos.id, repoIds[1]!), with: { org: true } });
    const results = await Promise.all([requestDeepScan({ ...repo!, loc: 50_000 }), requestDeepScan({ ...repo!, loc: 50_000 })]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, reason: "running" });
    // The winner's hold leaves 700, above the line. A hold by the loser would have left 200 and bought a top-up.
    expect(customer.credits).toBe(700);
    expect(customer.charges.slice(chargesBefore).filter((c) => c.what === "auto_top_up")).toHaveLength(0);
    customer.autoTopUp = null;
  });

  test("auto top-up buys whole packs of the plan, and follows a plan change", async () => {
    const choice = { enabled: true, quantity: 2_000, monthlyLimitUsd: 30 };
    await database.$client`update orgs set settings = ${JSON.stringify({ checkThreshold: "high", autoTopUp: choice })}::jsonb where id = ${acme.id}`;
    // Lockbox sells 2,500 credits for $10: 2,000 rounds up to one pack, and $30 a month is three.
    await applyAutoTopUp(acme.id, "lockbox", choice);
    expect(autumn.get(acme.id).autoTopUp).toEqual({ enabled: true, threshold: 500, quantity: 2_500, perMonth: 3 });

    await autumn.attach({ customerId: acme.id, planId: "standard", successUrl: "" });
    const row = await syncBilling(acme);
    expect(row.planId).toBe("standard");
    // Standard sells credits at $1 for 100: 2,000 for $20, so $30 a month is one top-up.
    expect(autumn.get(acme.id).autoTopUp).toEqual({ enabled: true, threshold: 500, quantity: 2_000, perMonth: 1 });
    expect((await orgBillingRow(database, acme.id))?.autoTopUp).toEqual({ enabled: true, threshold: 500, quantity: 2_000, perMonth: 1 });
  });

  test("auto top-up with no monthly limit keeps buying as credits run low", async () => {
    await applyAutoTopUp(acme.id, "standard", { enabled: true, quantity: 1_000, monthlyLimitUsd: null });
    expect(autumn.get(acme.id).autoTopUp).toEqual({ enabled: true, threshold: 500, quantity: 1_000, perMonth: null });
    const customer = autumn.get(acme.id);
    customer.topUpsThisMonth = 1_000;
    customer.credits = 500;
    const charges = customer.charges.length;
    await autumn.reserve({ customerId: acme.id, credits: 100, lockId: crypto.randomUUID(), expiresAt: new Date(Date.now() + 60_000) });
    expect(customer.charges.slice(charges).filter((c) => c.what === "auto_top_up")).toHaveLength(1);
    customer.autoTopUp = null;
  });

  test("a PR on an account with no plan gets a neutral 'no plan' Check", async () => {
    const { org } = await upsertInstallation(database, 777, { githubAccountId: 3, githubLogin: "solo", type: "User" }, [{ githubRepoId: 77, fullName: "solo/app", private: false, defaultBranch: "main" }]);
    const event = prEvent({ id: 77, full_name: "solo/app", private: false, default_branch: "main" }, 1, "solohead");
    event.installation.id = 777;
    const outcome = await handleWebhook(deps(), "pull_request", "solo-pr", event);
    expect((await beginScan(outcome.scans![0]!)).state).toBe("done");
    expect(checks.at(-1)).toMatchObject({ repo: "solo/app", conclusion: "neutral", title: "Not reviewed: no plan" });
    expect(await scanById(database, outcome.scans![0]!)).toMatchObject({ status: "refused", error: "Not run: this account has no plan." });
    expect(autumn.get(org.id).locks.size).toBe(0);
  });

  test("Autumn down at the start of a scan: the step fails, so the workflow retries it", async () => {
    autumn.failNext.add("reserve");
    const scanId = await openPr(4);
    await expect(beginScan(scanId)).rejects.toThrow("outage");
    expect(await scanById(database, scanId)).toMatchObject({ status: "queued", billing: null });
    expect((await beginScan(scanId)).state).toBe("running");
  });

  test("billing off (self-hosted): nothing is gated or recorded", async () => {
    setAutumn(undefined);
    try {
      const scanId = await openPr(5);
      expect((await beginScan(scanId)).state).toBe("running");
      expect(await scanById(database, scanId)).toMatchObject({ billing: null, creditsReserved: null });
    } finally {
      setAutumn(autumn);
    }
  });

  /** A PR review running since `minutesAgo`, holding 1,500 credits, with its Check in progress. */
  async function runningReview(head: string, minutesAgo: number, runId: string): Promise<{ id: string; check: number }> {
    checks.push({ repo: "acme/api", title: "Scanning…" });
    const check = checks.length;
    const [scan] = await database
      .insert(schema.scans)
      .values({ repoId: repoIds[0]!, orgId: acme.id, kind: "pr_review", trigger: "webhook", headSha: head, prNumber: 90, status: "running", checkRunId: check, workflowRunId: runId, startedAt: new Date(Date.now() - minutesAgo * 60_000) })
      .returning();
    expect(await reserveScan(scan!.id, acme, 1_500)).toEqual({ ok: true });
    return { id: scan!.id, check };
  }
  const cron = () => sweep(new Request("https://sandchest.test/api/cron/sweep", { headers: { authorization: "Bearer cron-secret" } }));

  test("the sweep leaves a slow scan whose workflow is still running, and it is charged when it finishes", async () => {
    // Settle what earlier tests left behind, so the balance below counts only this test's scans.
    await cron();
    autumn.get(acme.id).credits = 4_000;
    // Past the half-hour mark (a retried execute step can take it there), but its workflow is alive.
    const slow = await runningReview("slow", 31, "run-slow");
    runs.set("run-slow", "running");
    const response = await cron();
    expect(await response.json()).toMatchObject({ failed: 0, errors: 0 });
    expect(await scanById(database, slow.id)).toMatchObject({ status: "running", billing: "reserved" });
    expect(autumn.get(acme.id).credits).toBe(2_500);

    // The workflow finishes: the scan is charged what it measured, once.
    await database.$client`update scans set credits = 1_200, stats = ${JSON.stringify({ findingIds: [] })}::jsonb where id = ${slow.id}`;
    await publishScan(slow.id);
    expect(await scanById(database, slow.id)).toMatchObject({ status: "completed", billing: "charged", credits: 1_200 });
    expect(autumn.get(acme.id).credits).toBe(2_800);
    await publishScan(slow.id);
    await cron();
    expect(await scanById(database, slow.id)).toMatchObject({ status: "completed", billing: "charged", credits: 1_200 });
    expect(autumn.get(acme.id).credits).toBe(2_800);
    runs.delete("run-slow");
  });

  test("the sweep fails a scan whose workflow has ended, or that is running far past any budget", async () => {
    autumn.get(acme.id).credits = 4_000;
    const dead = await runningReview("dead", 31, "run-dead");
    runs.set("run-dead", "failed");
    const wedged = await runningReview("wedged", 3 * 60, "run-wedged");
    runs.set("run-wedged", "running");
    expect(autumn.get(acme.id).credits).toBe(1_000);
    const response = await cron();
    expect(await response.json()).toMatchObject({ failed: 2, errors: 0 });
    for (const scan of [dead, wedged]) {
      expect(await scanById(database, scan.id)).toMatchObject({ status: "failed", billing: "released", credits: 0 });
      expect(checks[scan.check - 1]).toMatchObject({ conclusion: "neutral", title: "Review could not finish" });
    }
    expect(autumn.get(acme.id).credits).toBe(4_000);

    // The wedged workflow turns up after all: the scan stays failed and released, with the Check that says so.
    await database.$client`update scans set credits = 1_200, stats = ${JSON.stringify({ findingIds: [] })}::jsonb where id = ${wedged.id}`;
    await publishScan(wedged.id);
    expect(await scanById(database, wedged.id)).toMatchObject({ status: "failed", billing: "released" });
    expect(checks[wedged.check - 1]).toMatchObject({ conclusion: "neutral", title: "Review could not finish" });
    expect(autumn.get(acme.id).credits).toBe(4_000);
    runs.delete("run-dead");
    runs.delete("run-wedged");
  });

  test("the sweep gives up on a start that never got its workflow, freeing the repo's Dig and its credits", async () => {
    await database.$client`update scans set status = 'completed' where repo_id = ${repoIds[0]!} and kind = 'deep' and status in ('queued', 'running', 'publishing')`;
    await cron();
    autumn.get(acme.id).credits = 4_000;
    const [scan] = await database
      .insert(schema.scans)
      .values({ repoId: repoIds[0]!, orgId: acme.id, kind: "deep", trigger: "manual", headSha: "wedged", createdAt: new Date(Date.now() - 40 * 60_000) })
      .returning();
    expect(await reserveScan(scan!.id, acme, 1_500)).toEqual({ ok: true });
    // The start was claimed, then the instance died before the workflow's run was recorded.
    await database.$client`update scans set workflow_run_id = ${"starting:lost"} where id = ${scan!.id}`;
    const repo = await database.query.repos.findFirst({ where: (repos, { eq }) => eq(repos.id, repoIds[0]!), with: { org: true } });
    expect(await requestDeepScan({ ...repo!, loc: 50_000 })).toMatchObject({ ok: false, reason: "running", scanId: scan!.id });

    const response = await cron();
    expect(await response.json()).toMatchObject({ errors: 0 });
    expect(await scanById(database, scan!.id)).toMatchObject({ status: "failed", billing: "released", credits: 0 });
    expect(autumn.get(acme.id).credits).toBe(4_000);
    // The repo can be dug again, paid like any Dig.
    const again = await requestDeepScan({ ...repo!, loc: 50_000 });
    expect(again.ok).toBe(true);
    expect(await scanById(database, (again as { scanId: string }).scanId)).toMatchObject({ creditsReserved: 500 });
  });
});
