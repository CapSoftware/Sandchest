/**
 * The operator dashboards: who may open them, the arithmetic, and the
 * aggregate queries against a real Postgres (local docker) with a small,
 * hand-counted data set. The database part skips without Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  adminActivity,
  adminCostByKind,
  adminDailyScans,
  adminDailySignups,
  adminFindingActivity,
  adminFindingTallies,
  adminFunnel,
  adminPlanCosts,
  adminScanTallies,
  createDb,
  recordDailyVisit,
  recordEvent,
  schema,
  upsertFindings,
  upsertInstallation,
  type Db,
  type FindingInput,
  type FindingTally,
  type KindCost,
} from "@sandchest/db";
import { migrate } from "@sandchest/db/migrate";
import { count, dayLabel, money, niceMax, percent } from "@/lib/admin-format";
import { costPerCredit, funnelSteps, lastDays, outcomes, parseRange, perDay, planMargins, ratio, survival } from "@/lib/admin-metrics";
import { createHmac } from "node:crypto";
import { adminGithubIds, isAdmin } from "@/server/admin";
import { config, resetConfig } from "@/server/config";
import { setDb } from "@/server/db";
import { isOperatorSession } from "@/server/operators";

// ---- Access ------------------------------------------------------------------

describe("admin access", () => {
  test("only listed GitHub user ids are operators", () => {
    const ids = adminGithubIds(" 42, 7 ,900950");
    expect([...ids]).toEqual([42, 7, 900950]);
    expect(isAdmin({ githubUserId: 42 }, ids)).toBe(true);
    expect(isAdmin({ githubUserId: 43 }, ids)).toBe(false);
    // No GitHub id (an account that never linked one), no session, or no list: nobody.
    expect(isAdmin({ githubUserId: null }, ids)).toBe(false);
    expect(isAdmin(undefined, ids)).toBe(false);
    expect(isAdmin({ githubUserId: 42 }, adminGithubIds(undefined))).toBe(false);
    expect(isAdmin({ githubUserId: 42 }, adminGithubIds(""))).toBe(false);
  });

  test("the allowlist must be ids, not logins", () => {
    const base = { DATABASE_URL: "postgres://x", GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "k", GITHUB_WEBHOOK_SECRET: "s", SANDCHEST_APP_URL: "https://sandchest.test" };
    expect(config({ ...base, SANDCHEST_ADMIN_GITHUB_IDS: "12, 34" }).SANDCHEST_ADMIN_GITHUB_IDS).toBe("12, 34");
    expect(() => config({ ...base, SANDCHEST_ADMIN_GITHUB_IDS: "octocat" })).toThrow(/SANDCHEST_ADMIN_GITHUB_IDS/);
    expect(() => config({ ...base, SANDCHEST_ADMIN_GITHUB_IDS: "12,octocat" })).toThrow(/GitHub user ids/);
  });

  test("the range comes from the URL and falls back to 30 days", () => {
    expect(parseRange("7")).toBe(7);
    expect(parseRange(["90", "7"])).toBe(90);
    expect(parseRange("31")).toBe(30);
    expect(parseRange("7; drop table")).toBe(30);
    expect(parseRange(undefined)).toBe(30);
  });
});

// ---- Arithmetic --------------------------------------------------------------

function tally(partial: Partial<FindingTally> & Pick<FindingTally, "severity" | "confidence" | "total">): FindingTally {
  return { open: 0, fixedAuto: 0, fixedManual: 0, falsePositive: 0, dismissedOther: 0, promptCopied: 0, ...partial };
}

function kindCost(partial: Partial<KindCost>): KindCost {
  return { kind: null, scans: 0, measured: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, modelCostUsd: 0, computeCostUsd: 0, duration: null, creditsCharged: 0, chargedModelCostUsd: 0, ...partial };
}

describe("admin arithmetic", () => {
  test("rates are null with nothing to divide by", () => {
    expect(ratio(1, 4)).toBe(0.25);
    expect(ratio(0, 0)).toBeNull();
    expect(percent(null)).toBe("–");
    expect(percent(0.25)).toBe("25%");
    expect(percent(0.004)).toBe("0.4%");
    expect(percent(0)).toBe("0%");
    expect(percent(-0.5)).toBe("-50%");
  });

  test("money, counts and axis tops", () => {
    expect(money(0)).toBe("$0");
    expect(money(0.0423)).toBe("$0.042");
    expect(money(0.5)).toBe("$0.50");
    expect(money(12.345)).toBe("$12.35");
    expect(money(1234.4)).toBe("$1,234");
    expect(money(null)).toBe("–");
    expect(count(12345.4)).toBe("12,345");
    expect([0, 0.3, 1, 7, 13, 21, 260, 999].map(niceMax)).toEqual([1, 0.5, 1, 10, 20, 25, 500, 1000]);
  });

  test("days are whole UTC days ending today, and missing days are zero", () => {
    const days = lastDays(3, new Date("2026-11-01T23:30:00-05:00"));
    expect(days).toEqual(["2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(dayLabel("2026-11-02")).toBe("2 Nov");
    expect(perDay(days, [{ day: "2026-11-02", v: 2 }, { day: "2026-11-02", v: 3 }, { day: "2026-10-01", v: 9 }], (row) => row.v)).toEqual([0, 0, 5]);
  });

  test("candidates and survivors count deep scans and PR reviews only", () => {
    const result = survival([
      { kind: "deep", status: "completed", scans: 2, candidates: 10, survivors: 4 },
      { kind: "deep", status: "failed", scans: 1, candidates: 2, survivors: 0 },
      { kind: "pr_review", status: "completed", scans: 5, candidates: 3, survivors: 3 },
      // A fix check's "candidates" are findings re-checked: not hunting.
      { kind: "fix_check", status: "completed", scans: 9, candidates: 50, survivors: 10 },
    ]);
    expect(result.byKind).toEqual([
      { kind: "deep", candidates: 12, survivors: 4, rate: 4 / 12 },
      { kind: "pr_review", candidates: 3, survivors: 3, rate: 1 },
    ]);
    expect(result.total).toEqual({ candidates: 15, survivors: 7, rate: 7 / 15 });
  });

  test("outcomes leave out low confidence, which people are not shown", () => {
    const result = outcomes([
      tally({ severity: "high", confidence: "high", total: 10, open: 4, fixedAuto: 2, fixedManual: 1, falsePositive: 2, dismissedOther: 1, promptCopied: 5 }),
      tally({ severity: "low", confidence: "medium", total: 10, open: 10, promptCopied: 1 }),
      tally({ severity: "critical", confidence: "low", total: 100, falsePositive: 100 }),
    ]);
    expect(result).toMatchObject({ shown: 20, open: 14, fixedAuto: 2, fixedManual: 1, falsePositive: 2, dismissedOther: 1, promptCopied: 6, reviewed: 6 });
    // Precision is judged on reviewed findings: 2 false positives in 6 fixed or dismissed.
    expect(result.falsePositiveRate).toBe(2 / 6);
    expect(result.precision).toBe(1 - 2 / 6);
    expect(result.fixRate).toBe(0.15);
    expect(result.autoFixShare).toBe(2 / 3);
    expect(result.promptCopyRate).toBe(0.3);
    expect(outcomes([])).toMatchObject({ shown: 0, reviewed: 0, precision: null, fixRate: null, autoFixShare: null, promptCopyRate: null });
  });

  test("open findings count neither for nor against precision", () => {
    const reviewed = tally({ severity: "high", confidence: "high", total: 4, fixedManual: 3, falsePositive: 1 });
    const withOpen = outcomes([reviewed, tally({ severity: "medium", confidence: "medium", total: 96, open: 96 })]);
    expect(withOpen.precision).toBe(0.75);
    expect(withOpen.precision).toBe(outcomes([reviewed]).precision);
    // Nothing reviewed yet: no precision to show, rather than 100%.
    expect(outcomes([tally({ severity: "high", confidence: "high", total: 50, open: 50 })]).precision).toBeNull();
  });

  test("cost per credit: from charged scans alone, and all in", () => {
    const total = kindCost({ creditsCharged: 100, chargedModelCostUsd: 8, modelCostUsd: 11, computeCostUsd: 1 });
    expect(costPerCredit(total)).toEqual({ paid: 0.08, allIn: 0.12 });
    expect(costPerCredit(kindCost({ modelCostUsd: 5 }))).toEqual({ paid: null, allIn: null });
    expect(costPerCredit(undefined)).toEqual({ paid: null, allIn: null });
  });

  test("margin per plan compares list price per credit with all-in cost per credit", () => {
    const plans = [
      { id: "lockbox", name: "Lockbox", price: 20, credits: 50, autoTopUp: { below: 1, packs: 1 } },
      { id: "chest", name: "Chest", price: 100, credits: 400, autoTopUp: { below: 1, packs: 1 } },
      { id: "vault", name: "Vault", price: 300, credits: 1000, autoTopUp: { below: 1, packs: 1 } },
    ] as const;
    const margins = planMargins(
      [
        { planId: "lockbox", orgs: 3, scans: 40, creditsCharged: 100, chargedModelCostUsd: 10, modelCostUsd: 12, computeCostUsd: 8 },
        { planId: "chest", orgs: 1, scans: 2, creditsCharged: 0, chargedModelCostUsd: 0, modelCostUsd: 3, computeCostUsd: 0 },
        { planId: null, orgs: 9, scans: 9, creditsCharged: 0, chargedModelCostUsd: 0, modelCostUsd: 50, computeCostUsd: 0 },
      ],
      plans.map((plan) => ({ ...plan, autoTopUp: { ...plan.autoTopUp } })),
    );
    // Lockbox: $0.40 a credit; cost (12 + 8) / 100 = $0.20 a credit; margin 50%.
    expect(margins[0]).toMatchObject({ orgs: 3, creditsCharged: 100, revenuePerCredit: 0.4, costPerCredit: 0.2, margin: 0.5 });
    // Chest: cost but no credits charged yet; no margin to show rather than a division by zero.
    expect(margins[1]).toMatchObject({ orgs: 1, revenuePerCredit: 0.25, costPerCredit: null, margin: null });
    // Vault: no scans at all.
    expect(margins[2]).toMatchObject({ orgs: 0, creditsCharged: 0, revenuePerCredit: 0.3, costPerCredit: null, margin: null });
  });

  test("funnel steps report each step against the one before and the start", () => {
    const steps = funnelSteps({ signedUp: 10, installed: 8, plan: 4, recon: 4, dig: 2, active30: 1, active7: 0 });
    expect(steps.map((step) => step.count)).toEqual([10, 8, 4, 4, 2, 1, 0]);
    expect(steps[0]!.fromPrevious).toBeNull();
    expect(steps[2]).toMatchObject({ fromPrevious: 0.5, fromStart: 0.4 });
    expect(steps[6]).toMatchObject({ fromPrevious: 0, fromStart: 0 });
    expect(funnelSteps({ signedUp: 0, installed: 0, plan: 0, recon: 0, dig: 0, active30: 0, active7: 0 })[1]).toMatchObject({ fromPrevious: null, fromStart: null });
  });
});

// ---- Aggregates against Postgres ---------------------------------------------

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest";
const NAME = `sandchest_admin_test_${process.pid}`;
let admin: postgres.Sql | undefined;
let database: Db;
let available = true;

function finding(fingerprint: string, severity: FindingInput["severity"], confidence: FindingInput["confidence"]): FindingInput {
  return {
    fingerprint,
    severity,
    confidence,
    category: "broken_access_control",
    cwe: "CWE-639",
    title: `Finding ${fingerprint}`,
    impact: "Fictional.",
    entryPoint: { file: "a.ts", line: 1, description: "GET /x" },
    attackPath: [{ file: "a.ts", line: 2, note: "sink" }],
    attacker: "any_user",
    preconditions: "None.",
    proofOfConcept: "curl /x",
    fixGuidance: "Scope it.",
    guarantees: [],
    mustNotBreak: [],
    regressionTest: "Request it.",
    fixPrompt: "",
  };
}

const ago = (days: number) => new Date(Date.now() - days * 86_400_000);

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
  resetConfig();
});

afterAll(async () => {
  if (!available) return;
  await database.$client.end();
  await admin!.unsafe(`drop database if exists ${NAME} with (force)`);
  await admin!.end();
});

describe("the proxy's operator check", () => {
  test("only a genuine session of a listed GitHub id passes", async () => {
    if (!available) return;
    const secret = "proxy-test-secret-proxy-test-secret-00";
    const saved = { ...process.env };
    Object.assign(process.env, { DATABASE_URL: "postgres://unused", GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "k", GITHUB_WEBHOOK_SECRET: "s", SANDCHEST_APP_URL: "http://sandchest.test", BETTER_AUTH_SECRET: secret, SANDCHEST_ADMIN_GITHUB_IDS: "4001" });
    resetConfig();
    setDb(database);
    const [operator, member] = await database
      .insert(schema.users)
      .values([
        { name: "Operator", email: "operator@example.com", githubUserId: 4001 },
        { name: "Member", email: "member@example.com", githubUserId: 4002 },
      ])
      .returning();
    await database.insert(schema.sessions).values([
      { userId: operator!.id, token: "operator-token", expiresAt: new Date(Date.now() + 86_400_000) },
      { userId: member!.id, token: "member-token", expiresAt: new Date(Date.now() + 86_400_000) },
      { userId: operator!.id, token: "expired-token", expiresAt: new Date(Date.now() - 1_000) },
    ]);
    const cookie = (token: string, key = secret) => ({ get: (name: string) => (name === "better-auth.session_token" ? { value: `${token}.${createHmac("sha256", key).update(token).digest("base64")}` } : undefined) });
    expect(await isOperatorSession(cookie("operator-token"))).toBe(true);
    expect(await isOperatorSession(cookie("member-token"))).toBe(false);
    expect(await isOperatorSession(cookie("expired-token"))).toBe(false);
    // A forged signature, or no cookie at all.
    expect(await isOperatorSession(cookie("operator-token", "another-secret-another-secret-0000"))).toBe(false);
    expect(await isOperatorSession({ get: () => undefined })).toBe(false);
    // With no operators listed nobody passes, and the database is not asked.
    delete process.env.SANDCHEST_ADMIN_GITHUB_IDS;
    resetConfig();
    expect(await isOperatorSession(cookie("operator-token"))).toBe(false);
    await database.$client`delete from users where github_user_id in (4001, 4002)`;
    // Leave the environment as other test files expect it.
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    resetConfig();
  });
});

describe("admin aggregates", () => {
  test("quality, cost and funnel numbers match a hand-counted data set", async () => {
    if (!available) return;
    // Two accounts: one on Lockbox, one without a plan.
    const paid = await upsertInstallation(database, 21, { githubAccountId: 2001, githubLogin: "fictional-paid", type: "Organization" }, [{ githubRepoId: 31, fullName: "fictional-paid/app", private: true, defaultBranch: "main" }]);
    const free = await upsertInstallation(database, 22, { githubAccountId: 2002, githubLogin: "fictional-free", type: "User" }, [{ githubRepoId: 32, fullName: "fictional-free/site", private: true, defaultBranch: "main" }]);
    const repo = paid.repos[0]!.id;
    await database.insert(schema.orgBilling).values({ orgId: paid.org.id, planId: "lockbox", credits: 40, activatedAt: ago(9) });

    const scan = async (values: Partial<typeof schema.scans.$inferInsert> & Pick<typeof schema.scans.$inferInsert, "kind" | "status">, metrics?: Partial<typeof schema.scanMetrics.$inferInsert>, org = paid) => {
      const [row] = await database
        .insert(schema.scans)
        .values({ repoId: org.repos[0]!.id, orgId: org.org.id, trigger: "webhook", headSha: crypto.randomUUID(), createdAt: ago(1), ...values })
        .returning();
      if (metrics) await database.insert(schema.scanMetrics).values({ scanId: row!.id, inputTokens: 1000, cachedTokens: 900, outputTokens: 50, requests: 3, durationMs: 1000, candidates: 0, survivors: 0, ...metrics });
      return row!;
    };
    const deep = await scan({ kind: "deep", status: "completed", trigger: "manual", credits: 15, billing: "charged" }, { modelCostUsd: "0.900000", durationMs: 100_000, candidates: 8, survivors: 3 });
    await scan({ kind: "pr_review", status: "completed", credits: 2, billing: "charged", prNumber: 1 }, { modelCostUsd: "0.100000", durationMs: 20_000, candidates: 2, survivors: 1 });
    await scan({ kind: "pr_review", status: "failed", billing: "released", prNumber: 2 }, { modelCostUsd: "0.050000", durationMs: 30_000, candidates: 1, survivors: 0 });
    await scan({ kind: "pr_review", status: "refused", prNumber: 3 });
    const recon = await scan({ kind: "recon", status: "completed", createdAt: ago(9) }, { modelCostUsd: "0.020000", durationMs: 10_000 });
    await scan({ kind: "fix_check", status: "completed" }, { modelCostUsd: "0.010000", durationMs: 5_000, candidates: 4, survivors: 1 });
    // Outside a 7-day range, inside 30 days.
    await scan({ kind: "deep", status: "completed", trigger: "manual", credits: 30, billing: "charged", createdAt: ago(12) }, { modelCostUsd: "1.500000", durationMs: 200_000, candidates: 5, survivors: 5 });
    // The free account ran recon only.
    await scan({ kind: "recon", status: "completed" }, { modelCostUsd: "0.030000", durationMs: 12_000 }, free);

    // Findings from the deep scan: two shown, one low confidence.
    const { ids } = await upsertFindings(database, repo, deep, [finding("a", "critical", "high"), finding("b", "high", "medium"), finding("c", "medium", "low")]);
    const [a, b, c] = ids as [string, string, string];
    const [person] = await database.insert(schema.users).values({ name: "Fictional", email: "fictional@example.com", githubUserId: 3001, createdAt: ago(3) }).returning();
    // a: fixed by a fix check, reopened, then marked fixed by a person: counts as fixed by hand.
    await database.$client`update findings set status = 'fixed', fixed_at = now() where id = ${a}`;
    await database.insert(schema.findingEvents).values([
      { findingId: a, type: "fixed", scanId: recon.id },
      { findingId: a, type: "reopened", userId: person!.id },
      { findingId: a, type: "fixed", userId: person!.id },
      { findingId: a, type: "prompt_copied", userId: person!.id },
      { findingId: a, type: "prompt_copied", userId: person!.id },
    ]);
    // b: dismissed as a false positive. c: fixed by a fix check (low confidence, so outside the shown rates).
    await database.$client`update findings set status = 'dismissed', dismiss_reason = 'false_positive' where id = ${b}`;
    await database.insert(schema.findingEvents).values({ findingId: b, type: "dismissed", userId: person!.id });
    await database.$client`update findings set status = 'fixed' where id = ${c}`;
    await database.insert(schema.findingEvents).values({ findingId: c, type: "fixed", scanId: recon.id });

    // Quality.
    const scans7 = await adminScanTallies(database, 7);
    // Recon 9 days ago and a deep scan 12 days ago fall outside 7 days.
    expect(scans7.reduce((sum, row) => sum + row.scans, 0)).toBe(6);
    expect(survival(scans7).total).toEqual({ candidates: 11, survivors: 4, rate: 4 / 11 });
    expect(survival(await adminScanTallies(database, 30)).total).toEqual({ candidates: 16, survivors: 9, rate: 9 / 16 });
    const findings = await adminFindingTallies(database, 7);
    expect(findings.find((row) => row.severity === "critical")).toMatchObject({ total: 1, fixedAuto: 0, fixedManual: 1, promptCopied: 1 });
    expect(findings.find((row) => row.severity === "high")).toMatchObject({ total: 1, falsePositive: 1 });
    expect(findings.find((row) => row.severity === "medium")).toMatchObject({ confidence: "low", total: 1, fixedAuto: 1 });
    expect(outcomes(findings)).toMatchObject({ shown: 2, precision: 0.5, fixRate: 0.5, autoFixShare: 0, promptCopyRate: 0.5 });
    const activity = await adminFindingActivity(database, 7);
    const events = (type: string, auto: boolean) => activity.find((row) => row.type === type && row.auto === auto);
    expect(events("fixed", true)).toMatchObject({ events: 2, findings: 2 });
    expect(events("fixed", false)).toMatchObject({ events: 1, findings: 1 });
    expect(events("prompt_copied", false)).toMatchObject({ events: 2, findings: 1 });

    // Cost: the 7-day total row, and per-kind percentiles.
    const cost = await adminCostByKind(database, 7);
    const total = cost.find((row) => row.kind === null)!;
    expect(total).toMatchObject({ scans: 6, measured: 5, creditsCharged: 17 });
    expect(total.modelCostUsd).toBeCloseTo(1.09, 6);
    expect(total.chargedModelCostUsd).toBeCloseTo(1.0, 6);
    expect(cost.find((row) => row.kind === "pr_review")).toMatchObject({ scans: 3, measured: 2, duration: { p50: 25_000, p90: 29_000, p99: 29_900 } });
    expect(cost.find((row) => row.kind === "deep")!.duration).toEqual({ p50: 100_000, p90: 100_000, p99: 100_000 });
    expect(costPerCredit(total).paid).toBeCloseTo(1 / 17, 9);
    const daily = await adminDailyScans(database, 30);
    expect(daily.reduce((sum, row) => sum + row.scans, 0)).toBe(8);
    expect(daily.reduce((sum, row) => sum + row.failed, 0)).toBe(1);
    expect(perDay(lastDays(30), daily, (row) => row.modelCostUsd).reduce((x, y) => x + y, 0)).toBeCloseTo(2.61, 6);
    const plans = await adminPlanCosts(database, 30);
    expect(plans.find((row) => row.planId === "lockbox")).toMatchObject({ orgs: 1, scans: 7, creditsCharged: 47 });
    expect(plans.find((row) => row.planId === null)).toMatchObject({ orgs: 1, scans: 1, creditsCharged: 0 });
    expect(plans.find((row) => row.planId === "lockbox")!.modelCostUsd).toBeCloseTo(2.58, 6);

    // Funnel: the person signed up 3 days ago and can see the paid account (recon done, dug).
    // A second person can see only the free account; a third sees nothing; a fourth signed up long ago.
    const [second] = await database.insert(schema.users).values({ name: "Fictional 2", email: "fictional2@example.com", createdAt: ago(2) }).returning();
    await database.insert(schema.users).values({ name: "Fictional 3", email: "fictional3@example.com", createdAt: ago(1) });
    await database.insert(schema.users).values({ name: "Fictional 4", email: "fictional4@example.com", createdAt: ago(60) });
    await database.insert(schema.permissionCache).values({ userId: person!.id, repoId: repo, permission: "write" });
    await database.insert(schema.orgAdmins).values({ userId: second!.id, orgId: free.org.id });
    // Visits: the person came back yesterday; the second only on the day they signed up.
    await database.insert(schema.events).values([
      { name: "dashboard_visit", userId: person!.id, createdAt: ago(1) },
      { name: "dashboard_visit", userId: second!.id, createdAt: ago(2) },
    ]);
    expect(await adminFunnel(database, 7)).toEqual({ signedUp: 3, installed: 2, plan: 1, recon: 1, dig: 1, active30: 1, active7: 1 });
    expect((await adminFunnel(database, 90)).signedUp).toBe(4);

    // A visit is recorded once a day however often it is written.
    await recordDailyVisit(database, second!.id);
    await recordDailyVisit(database, second!.id);
    await recordEvent(database, { name: "signed_in", userId: second!.id });
    const [{ visits }] = (await database.$client`select count(*)::int as visits from events where user_id = ${second!.id} and name = 'dashboard_visit' and created_at > now() - interval '1 hour'`) as unknown as [{ visits: number }];
    expect(visits).toBe(1);
    const activityNow = await adminActivity(database);
    expect(activityNow).toEqual({ people: 4, people7: 2, people30: 2, orgs: 2, paying: 1, orgs7: 2, orgs30: 2 });
    const signups = await adminDailySignups(database, 7);
    expect(signups.reduce((sum, row) => sum + row.signups, 0)).toBe(3);
    expect(signups.reduce((sum, row) => sum + row.signIns, 0)).toBe(1);
  });
});
