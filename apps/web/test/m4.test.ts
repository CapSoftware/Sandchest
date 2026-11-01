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
import { applyAutoTopUp, hasPlan, reserveScan, setAutumn, syncBilling } from "@/server/billing";
import { requestDeepScan } from "@/server/dig";
import { beginScan, failScan, publishScan } from "@/server/scans";
import { resetConfig } from "@/server/config";
import { setServices } from "@/server/services";
import { setScanStarter } from "@/server/start";
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
    branchSha: async () => "deadbeef",
  }),
} as unknown as GitHubApp;

const autumn = new FakeAutumn();
const started: string[] = [];
const deps = () => ({ db: database, github: fakeGithub, startScan: async (id: string) => void started.push(id), hasPlan });
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
  setServices({ db: database, github: fakeGithub });
  setAutumn(autumn);
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
    expect(outcome).toMatchObject({ status: "handled", scans: [], detail: "recon waits for a plan" });
    const org = await database.query.orgs.findFirst({ where: (orgs, { eq }) => eq(orgs.installationId, 501) });
    acme = { id: org!.id, githubLogin: "acme" };
    repoIds = (await database.query.repos.findMany({ where: (repos, { eq }) => eq(repos.orgId, acme.id) })).map((r) => r.id);
    expect((await orgBillingRow(database, acme.id))?.planId).toBeNull();

    // Checkout completes in Autumn; the return page (or any page) reads it.
    await autumn.attach({ customerId: acme.id, planId: "lockbox", successUrl: "" });
    const before = started.length;
    const [first, second] = await Promise.all([syncBilling(acme), syncBilling(acme)]);
    expect(first.planId).toBe("lockbox");
    expect(second.credits).toBe(60);
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
    expect(await scanById(database, scanId)).toMatchObject({ billing: "reserved", creditsReserved: 1 });
    expect(autumn.get(acme.id).credits).toBe(59);
    expect((await orgBillingRow(database, acme.id))?.credits).toBe(59);

    // A retried begin step neither reserves twice nor posts a second Check.
    const checkCount = checks.length;
    await beginScan(scanId);
    expect(checks.length).toBe(checkCount);
    expect(autumn.get(acme.id).credits).toBe(59);

    // The engine reported more than was shown up front: never charge more than was held.
    await database.$client`update scans set credits = 3, stats = ${JSON.stringify({ findingIds: [] })}::jsonb where id = ${scanId}`;
    await publishScan(scanId);
    expect(await scanById(database, scanId)).toMatchObject({ status: "completed", billing: "charged", credits: 1 });
    expect(autumn.get(acme.id).credits).toBe(59);
    expect(autumn.get(acme.id).locks.size).toBe(0);
    expect(checks.at(-1)).toMatchObject({ conclusion: "success" });
  });

  test("a scan that fails gives its credits back", async () => {
    const scanId = await openPr(2);
    await beginScan(scanId);
    expect(autumn.get(acme.id).credits).toBe(58);
    await failScan(scanId, "model provider down");
    expect(await scanById(database, scanId)).toMatchObject({ status: "failed", billing: "released", credits: 0 });
    expect(autumn.get(acme.id).credits).toBe(59);
    expect(checks.at(-1)).toMatchObject({ conclusion: "neutral", title: "Review could not finish" });
    // Failing again (a retried step) changes nothing.
    await failScan(scanId, "again");
    expect(autumn.get(acme.id).credits).toBe(59);
  });

  test("out of credits: a neutral Check that links to billing, and nothing held", async () => {
    autumn.get(acme.id).credits = 0;
    const scanId = await openPr(3);
    expect((await beginScan(scanId)).state).toBe("done");
    expect(await scanById(database, scanId)).toMatchObject({ status: "refused", billing: null });
    expect(checks.at(-1)).toMatchObject({ conclusion: "neutral", title: "Out of credits" });
    expect(checks.at(-1)!.summary).toContain("needs 1 credit");
    expect(checks.at(-1)!.summary).toContain("https://sandchest.test/dashboard/settings");
    expect(autumn.get(acme.id).locks.size).toBe(0);
    // The refusal also refreshed what the dashboard shows.
    expect((await orgBillingRow(database, acme.id))?.credits).toBe(0);
  });

  test("out of credits while Autumn can't be read: still 'out of credits', not 'no plan'", async () => {
    // Before, a failed re-read after a refusal was taken to mean the org had no plan.
    autumn.failNext.add("customer");
    expect(await reserveScan("00000000-0000-4000-8000-00000000f00d", acme, 1, false)).toEqual({ ok: false, reason: "out_of_credits", credits: 1 });
    expect(autumn.failNext.size).toBe(0);
  });

  test("Dig: refused without credits leaves no scan; with credits it holds the cost shown", async () => {
    const repo = await database.query.repos.findFirst({ where: (repos, { eq }) => eq(repos.id, repoIds[0]!), with: { org: true } });
    const before = (await database.query.scans.findMany()).length;
    expect(await requestDeepScan(repo!)).toEqual({ ok: false, reason: "out_of_credits", credits: 15 });
    expect((await database.query.scans.findMany()).length).toBe(before);

    // A top-up with the card on file.
    await autumn.attach({ customerId: acme.id, planId: "top_up", packs: 1, successUrl: "" });
    const result = await requestDeepScan({ ...repo!, loc: 50_000 });
    expect(result.ok).toBe(true);
    const scan = await scanById(database, (result as { scanId: string }).scanId);
    expect(scan).toMatchObject({ kind: "deep", billing: "reserved", creditsReserved: 15 });
    expect(autumn.get(acme.id).credits).toBe(10);
    expect(started).toContain(scan!.id);
  });

  test("the sweep settles what finished scans still hold", async () => {
    autumn.get(acme.id).credits = 40;
    const ids: string[] = [];
    for (const status of ["failed", "completed"] as const) {
      const [scan] = await database.insert(schema.scans).values({ repoId: repoIds[1]!, orgId: acme.id, kind: "deep", trigger: "manual", headSha: status }).returning();
      expect(await reserveScan(scan!.id, acme, 15)).toEqual({ ok: true });
      await database.$client`update scans set status = ${status}, credits = 15 where id = ${scan!.id}`;
      ids.push(scan!.id);
    }
    expect(autumn.get(acme.id).credits).toBe(10);
    const unauthorized = await sweep(new Request("https://sandchest.test/api/cron/sweep"));
    expect(unauthorized.status).toBe(401);
    const response = await sweep(new Request("https://sandchest.test/api/cron/sweep", { headers: { authorization: "Bearer cron-secret" } }));
    expect(await response.json()).toMatchObject({ settled: 2, errors: 0 });
    expect(await scanById(database, ids[0]!)).toMatchObject({ billing: "released", credits: 0 });
    expect(await scanById(database, ids[1]!)).toMatchObject({ billing: "charged", credits: 15 });
    expect(autumn.get(acme.id).credits).toBe(25);
  });

  test("the sweep restarts lost starts and fails stuck PR reviews, so no Check spins forever", async () => {
    // A scan whose workflow start was lost 10 minutes ago, and a PR review stuck for an hour with its Check in progress.
    checks.push({ repo: "acme/api", title: "Digging…" });
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
    autumn.get(acme.id).credits = 40;
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
    // Only the winner's 15 credits stay held.
    expect(autumn.get(acme.id).credits).toBe(25);
  });

  test("a Dig that loses the race never reaches Autumn: no hold, no auto top-up", async () => {
    // Free the slot left by the previous test, then arm auto top-up below 15 credits.
    await database.$client`update scans set status = 'completed' where repo_id = ${repoIds[1]!} and kind = 'deep'`;
    const customer = autumn.get(acme.id);
    customer.credits = 40;
    customer.autoTopUp = { enabled: true, threshold: 15, quantity: 25, perMonth: 4 };
    customer.topUpsThisMonth = 0;
    const chargesBefore = customer.charges.length;
    const repo = await database.query.repos.findFirst({ where: (repos, { eq }) => eq(repos.id, repoIds[1]!), with: { org: true } });
    const results = await Promise.all([requestDeepScan({ ...repo!, loc: 50_000 }), requestDeepScan({ ...repo!, loc: 50_000 })]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, reason: "running" });
    // The winner's hold leaves 25, above the line. A hold by the loser would have left 10 and bought a top-up.
    expect(customer.credits).toBe(25);
    expect(customer.charges.slice(chargesBefore).filter((c) => c.what === "auto_top_up")).toHaveLength(0);
    customer.autoTopUp = null;
  });

  test("auto top-up is sized for the plan, and follows a plan change", async () => {
    await database.$client`update orgs set settings = ${JSON.stringify({ checkThreshold: "high", autoTopUp: { enabled: true, monthlyLimitUsd: 40 } })}::jsonb where id = ${acme.id}`;
    await applyAutoTopUp(acme.id, "lockbox", { enabled: true, monthlyLimitUsd: 40 });
    expect(autumn.get(acme.id).autoTopUp).toEqual({ enabled: true, threshold: 15, quantity: 25, perMonth: 4 });

    await autumn.attach({ customerId: acme.id, planId: "chest", successUrl: "" });
    const row = await syncBilling(acme);
    expect(row.planId).toBe("chest");
    // Chest buys 50 at a time ($20), so $40 a month is two top-ups.
    expect(autumn.get(acme.id).autoTopUp).toEqual({ enabled: true, threshold: 30, quantity: 50, perMonth: 2 });
    expect((await orgBillingRow(database, acme.id))?.autoTopUp).toEqual({ enabled: true, threshold: 30, quantity: 50, perMonth: 2 });
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
});
