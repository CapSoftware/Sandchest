/**
 * Free credits from /claim against a real Postgres, with GitHub and Autumn
 * faked: who may claim, claims that are retried, raced or die half way, and
 * what happens once the credits are spent (nothing runs) and after joining
 * Standard (the leftover credits carry across and work starts again).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { FREE_CREDITS } from "@sandchest/billing";
import { createDb, orgBillingRow, scanById, schema, startCreditClaim, upsertInstallation, type Db } from "@sandchest/db";
import { migrate } from "@sandchest/db/migrate";
import type { GitHubApp } from "@sandchest/github";
import { applyAutoTopUp, canScan, reserveScan, setAutumn, syncBilling } from "@/server/billing";
import { requestDeepScan } from "@/server/dig";
import { claimFreeCredits, claimOffers } from "@/server/free-credits";
import { beginScan } from "@/server/scans";
import { resetConfig } from "@/server/config";
import { setServices } from "@/server/services";
import { setScanStarter } from "@/server/start";
import { handleWebhook } from "@/server/webhooks";
import { FakeAutumn } from "./fake-autumn";

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest";
const NAME = `sandchest_free_credits_test_${process.pid}`;

let admin: postgres.Sql | undefined;
let database: Db;
let available = true;

const checks: Array<{ repo: string; title: string; conclusion?: string; summary?: string }> = [];
const repoList = [
  { id: 71, full_name: "acme/api", private: true, default_branch: "main" },
  { id: 72, full_name: "acme/web", private: true, default_branch: "main" },
];
const fakeGithub = {
  installation: () => ({
    repositories: async () => repoList,
    pullFiles: async () => [{ filename: "src/app.js", status: "modified", additions: 8, deletions: 4, patch: "@@ -1 +1 @@\n-a\n+b" }],
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
const deps = () => ({ db: database, github: fakeGithub, startScan: async (id: string) => void started.push(id), canScan });

/** People and accounts, all fictional. */
let alice: { id: string; githubUserId: number };
let bob: { id: string; githubUserId: number };
let acme: { id: string; githubLogin: string };
let globex: { id: string; githubLogin: string };
let initech: { id: string; githubLogin: string };
let hooli: { id: string; githubLogin: string };

async function person(name: string, githubUserId: number) {
  const [row] = await database.insert(schema.users).values({ name, email: `${name}@example.com`, login: name, githubUserId }).returning();
  return { id: row!.id, githubUserId };
}

async function account(installationId: number, githubAccountId: number, login: string, admins: Array<{ id: string }>) {
  const { org } = await upsertInstallation(
    database,
    installationId,
    { githubAccountId, githubLogin: login, type: "Organization" },
    installationId === 601 ? repoList.map((r) => ({ githubRepoId: r.id, fullName: r.full_name, private: r.private, defaultBranch: r.default_branch })) : [],
  );
  await database.insert(schema.orgAdmins).values(admins.map((a) => ({ userId: a.id, orgId: org.id })));
  return { id: org.id, githubLogin: login };
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
  Object.assign(process.env, { DATABASE_URL: url.toString(), GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "unused", GITHUB_WEBHOOK_SECRET: "unused", SANDCHEST_APP_URL: "https://sandchest.test", CRON_SECRET: "cron-secret" });
  resetConfig();
  database = createDb(url.toString(), { max: 5 });
  await migrate(database);
  setServices({ db: database, github: fakeGithub });
  setAutumn(autumn);
  setScanStarter(async (id) => void started.push(id));

  alice = await person("alice", 5001);
  bob = await person("bob", 5002);
  acme = await account(601, 9001, "acme", [alice, bob]);
  globex = await account(602, 9002, "globex", [alice]);
  initech = await account(603, 9003, "initech", [bob]);
  hooli = await account(604, 9004, "hooli", [bob]);
});

afterAll(async () => {
  setAutumn(undefined);
  setScanStarter(undefined);
  if (!available) return;
  await database.$client.end();
  await admin!.unsafe(`drop database if exists ${NAME} with (force)`);
  await admin!.end();
});

const claimRow = async (githubAccountId: number) => database.query.creditClaims.findFirst({ where: (c, { eq }) => eq(c.githubAccountId, githubAccountId) });

describe.skipIf(!available)("free credits", () => {
  test("before claiming, an account with no plan scans nothing: recon waits", async () => {
    const outcome = await handleWebhook(deps(), "installation", "install-acme", { action: "created", installation: { id: 601, account: { id: 9001, login: "acme", type: "Organization" } } });
    expect(outcome).toMatchObject({ status: "handled", scans: [] });
    expect(await claimOffers(alice)).toMatchObject({ [acme.id]: { open: true, credits: FREE_CREDITS.credits }, [globex.id]: { open: true } });
  });

  test("a claim that dies half way (the grant fails) charges nothing and can be finished by trying again", async () => {
    autumn.failNext.add("grant");
    expect(await claimFreeCredits(alice, acme.id)).toEqual({ ok: false, reason: "failed" });
    expect(autumn.get(acme.id)).toMatchObject({ planId: null, credits: 0 });
    // The account's one claim is held for alice, unfinished: nobody else can take it, and she can still finish it.
    expect(await claimRow(9001)).toMatchObject({ githubUserId: 5001, grantedAt: null });
    expect((await claimOffers(alice))[acme.id]).toEqual({ open: true, credits: FREE_CREDITS.credits });
    expect((await claimOffers(bob))[acme.id]).toEqual({ open: false, reason: "org_claimed" });
    expect(await claimFreeCredits(bob, acme.id)).toEqual({ ok: false, reason: "org_claimed" });
  });

  test("a retry after the plan failed to attach grants the credits once, not twice", async () => {
    autumn.failNext.add("attach");
    expect(await claimFreeCredits(alice, acme.id)).toEqual({ ok: false, reason: "failed" });
    expect(autumn.get(acme.id)).toMatchObject({ planId: null, credits: FREE_CREDITS.credits });
    // With credits but no plan, still nothing runs.
    expect(await canScan(acme)).toBe(false);

    started.length = 0;
    // Two tries at once (a double click): one grant, one plan, no error.
    const results = await Promise.all([claimFreeCredits(alice, acme.id), claimFreeCredits(alice, acme.id)]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(autumn.get(acme.id)).toMatchObject({ planId: "trial", credits: FREE_CREDITS.credits, card: false });
    expect(autumn.get(acme.id).charges.filter((charge) => charge.usd > 0)).toEqual([]);
    expect((await claimRow(9001))?.grantedAt).toBeInstanceOf(Date);
    // The free plan is a plan: recon starts on every repository, once.
    expect(started).toHaveLength(2);
    expect((await orgBillingRow(database, acme.id))?.planId).toBe("trial");
    // And it's done: claiming again changes nothing.
    expect(await claimFreeCredits(alice, acme.id)).toEqual({ ok: true });
    expect(autumn.get(acme.id).credits).toBe(FREE_CREDITS.credits);
  });

  test("one claim per person and per account", async () => {
    expect((await claimOffers(alice))[globex.id]).toEqual({ open: false, reason: "claimed_elsewhere", login: "acme" });
    expect(await claimFreeCredits(alice, globex.id)).toEqual({ ok: false, reason: "claimed_elsewhere", login: "acme" });
    expect(autumn.customers.get(globex.id)?.credits ?? 0).toBe(0);
    // Bob administers acme too, but acme has claimed.
    expect(await claimFreeCredits(bob, acme.id)).toEqual({ ok: false, reason: "org_claimed" });
    // Someone who isn't an admin can't claim for an account at all.
    expect(await claimFreeCredits(bob, globex.id)).toEqual({ ok: false, reason: "not_admin" });
  });

  test("an account that has, or has had, a plan can't claim", async () => {
    // initech joins Standard, then cancels: it had a plan.
    await autumn.attach({ customerId: initech.id, planId: "standard", credits: 10, successUrl: "" });
    await syncBilling(initech);
    expect((await claimOffers(bob))[initech.id]).toEqual({ open: false, reason: "has_plan" });
    autumn.get(initech.id).planId = null;
    await syncBilling(initech);
    expect((await orgBillingRow(database, initech.id))?.activatedAt).toBeInstanceOf(Date);
    expect(await claimFreeCredits(bob, initech.id)).toEqual({ ok: false, reason: "has_plan" });
    expect(await claimRow(9003)).toBeUndefined();
  });

  test("claims stop at the limit, even when they race", async () => {
    const count = async () => (await database.$client<Array<{ n: number }>>`select count(*)::int as n from credit_claims`)[0]!.n;
    const limit = (await count()) + 2;
    const outcomes = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => startCreditClaim(database, { githubAccountId: 80_000 + n, githubUserId: 70_000 + n, orgId: acme.id, userId: alice.id, credits: 1 }, limit)),
    );
    expect(outcomes.filter((o) => o === "new")).toHaveLength(2);
    expect(outcomes.filter((o) => o === "exhausted")).toHaveLength(3);
    expect(await count()).toBe(limit);
    await database.$client`delete from credit_claims where github_account_id > 80000`;
  });

  test("auto top-up never turns on for free credits: there's no card", async () => {
    expect(await applyAutoTopUp(acme.id, "trial", { enabled: true, quantity: 10, monthlyLimitUsd: 50 })).toMatchObject({ enabled: false });
    expect(autumn.get(acme.id).autoTopUp).toMatchObject({ enabled: false });
  });

  test("free credits pay for work like bought ones", async () => {
    const scanId = (await handleWebhook(deps(), "pull_request", "pr-1", prEvent(1))).scans![0]!;
    expect((await beginScan(scanId)).state).toBe("running");
    expect(await scanById(database, scanId)).toMatchObject({ billing: "reserved", creditsReserved: 1 });
    expect(autumn.get(acme.id).credits).toBe(FREE_CREDITS.credits - 1);
  });

  test("once they're spent, nothing runs: no reviews, no recon, no fix checks, no Digs, not even the free one", async () => {
    autumn.get(acme.id).credits = 0;
    const held = autumn.get(acme.id).locks.size;
    await syncBilling(acme);

    const review = (await handleWebhook(deps(), "pull_request", "pr-2", prEvent(2))).scans![0]!;
    expect((await beginScan(review)).state).toBe("done");
    expect(await scanById(database, review)).toMatchObject({ status: "refused", billing: null });
    expect(checks.at(-1)).toMatchObject({ conclusion: "neutral", title: "Out of credits" });

    // Free scans are refused too.
    for (const kind of ["recon", "fix_check"] as const) {
      const [scan] = await database.insert(schema.scans).values({ repoId: (await repoId(71))!, orgId: acme.id, kind, trigger: "webhook", headSha: `zero-${kind}` }).returning();
      expect(await reserveScan(scan!.id, acme, 0)).toEqual({ ok: false, reason: "out_of_credits", credits: 0 });
    }
    // A new repository's recon waits.
    expect(await canScan(acme)).toBe(false);
    repoList.push({ id: 73, full_name: "acme/worker", private: true, default_branch: "main" });
    const added = await handleWebhook(deps(), "installation_repositories", "repos-added", {
      action: "added",
      installation: { id: 601 },
      repositories_added: [{ id: 73, full_name: "acme/worker" }],
      repositories_removed: [],
    });
    expect(added).toMatchObject({ status: "handled", scans: [], detail: "recon waits for a plan and credits" });

    // The org's free first Dig is still unused, and still doesn't run.
    const repo = await database.query.repos.findFirst({ where: (repos, { eq }) => eq(repos.githubRepoId, 71), with: { org: true } });
    const scans = (await database.query.scans.findMany()).length;
    expect(await requestDeepScan(repo!)).toMatchObject({ ok: false, reason: "out_of_credits" });
    expect(autumn.get(acme.id).locks.size).toBe(held);
    expect((await database.query.scans.findMany()).length).toBe(scans);
  });

  test("an outage while checking the balance falls back to the stored copy, never to 'free for all'", async () => {
    autumn.failNext.add("check");
    expect(await reserveScan("00000000-0000-4000-8000-0000000c1a1e", acme, 0, false)).toEqual({ ok: false, reason: "out_of_credits", credits: 0 });
  });

  test("joining Standard keeps the free credits left and starts the waiting work again", async () => {
    // Recon that was refused for want of credits, as the gate leaves it.
    await database.$client`update scans set status = 'refused' where org_id = ${acme.id} and kind = 'recon' and status = 'queued'`;
    expect((await orgBillingRow(database, acme.id))?.credits).toBe(0);
    autumn.get(acme.id).credits = 3; // free credits left over, not yet seen
    started.length = 0;
    // Stripe Checkout: the free plan has no card, so the fake hands back a checkout URL and settles.
    const { paymentUrl } = await autumn.attach({ customerId: acme.id, planId: "standard", credits: 10, successUrl: "" });
    expect(paymentUrl).toContain("checkout");
    const state = await syncBilling(acme);
    expect(state).toMatchObject({ planId: "standard", credits: 13 });
    // Credits came back: every repository without a threat model gets its recon, the one added while out included.
    const recons = await database.query.scans.findMany({ where: (scans, { and, eq }) => and(eq(scans.orgId, acme.id), eq(scans.kind, "recon"), eq(scans.status, "queued")) });
    expect(recons).toHaveLength(3);
    expect(started).toHaveLength(3);
    expect(await canScan(acme)).toBe(true);
    // Later reads queue nothing more.
    await syncBilling(acme);
    expect(started).toHaveLength(3);
  });

  test("credits back without a sync (seen by a scan's balance check) restart the recon that waited", async () => {
    autumn.get(acme.id).credits = 0;
    await syncBilling(acme);
    await database.$client`update scans set status = 'refused' where org_id = ${acme.id} and kind = 'recon' and status = 'queued'`;
    started.length = 0;
    autumn.get(acme.id).credits = 5; // bought; no page has synced yet
    const [scan] = await database.insert(schema.scans).values({ repoId: (await repoId(71))!, orgId: acme.id, kind: "fix_check", trigger: "webhook", headSha: "back" }).returning();
    expect(await reserveScan(scan!.id, acme, 0)).toEqual({ ok: true });
    expect(started).toHaveLength(3);
  });

  test("a finished claim is never run again: a lapsed paid plan doesn't come back as free credits", async () => {
    autumn.get(acme.id).planId = null; // Standard cancelled and expired
    await syncBilling(acme);
    expect(await claimFreeCredits(alice, acme.id)).toEqual({ ok: false, reason: "claimed_elsewhere", login: "acme" });
    expect(autumn.get(acme.id).planId).toBeNull();
    expect((await claimOffers(alice))[acme.id]).toMatchObject({ open: false });
  });

  test("a plan bought in another tab while the claim runs is never replaced by the free one", async () => {
    const grant = autumn.grant.bind(autumn);
    autumn.grant = async (input) => {
      await grant(input);
      // Stripe Checkout finishes for Standard in another tab, mid-claim.
      autumn.get(hooli.id).planId = "standard";
    };
    try {
      expect(await claimFreeCredits(bob, hooli.id)).toEqual({ ok: true });
    } finally {
      autumn.grant = grant;
    }
    expect(autumn.get(hooli.id).planId).toBe("standard");
    expect(autumn.get(hooli.id).credits).toBe(FREE_CREDITS.credits);
  });
});

function prEvent(number: number) {
  const repo = repoList[0]!;
  return {
    action: "opened",
    number,
    installation: { id: 601 },
    repository: repo,
    sender: { login: "dev" },
    pull_request: { number, draft: false, head: { sha: `head${number}`, ref: "f", repo: { id: repo.id, full_name: repo.full_name } }, base: { sha: "base", ref: "main", repo: { id: repo.id } }, author_association: "MEMBER" },
  };
}

async function repoId(githubRepoId: number) {
  return (await database.query.repos.findFirst({ where: (repos, { eq }) => eq(repos.githubRepoId, githubRepoId) }))?.id;
}
