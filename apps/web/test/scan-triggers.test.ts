/**
 * What a push or a PR may start, against a real Postgres with GitHub faked:
 * free scans (recon, fix checks) stay free but bounded, so a burst of pushes
 * costs one scan, not one per push.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { claimScanSlot, claimWorkflowStart, createDb, createScan, saveThreatModel, updateScan, upsertFindings, upsertInstallation, type Db } from "@sandchest/db";
import { migrate } from "@sandchest/db/migrate";
import type { GitHubApp } from "@sandchest/github";
import { resetConfig } from "@/server/config";
import { executeScan } from "@/server/scans";
import { setServices } from "@/server/services";
import { handleWebhook } from "@/server/webhooks";

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest";
const NAME = `sandchest_scan_triggers_test_${process.pid}`;

let admin: postgres.Sql | undefined;
let database: Db;
let available = true;

const repoList = [
  { id: 81, full_name: "acme/api", private: true, default_branch: "main" },
  { id: 82, full_name: "acme/web", private: true, default_branch: "main" },
  { id: 83, full_name: "acme/new", private: true, default_branch: "main" },
  { id: 84, full_name: "acme/fresh", private: true, default_branch: "main" },
];
/** Each person's role on every repo, as GitHub's permission API reports it. */
const roles: Record<string, string> = { reader: "read", writer: "write" };
let clones = 0;
const fakeGithub = {
  installation: () => ({
    repositories: async () => repoList,
    cloneToken: async () => {
      clones++;
      return "token";
    },
    compare: async () => [{ filename: "README.md", status: "modified", additions: 1, deletions: 0 }],
    permission: async (_repo: string, login: string) => roles[login] ?? "none",
    pullFiles: async () => [],
    createCheckRun: async () => 1,
    completeCheckRun: async () => {},
  }),
} as unknown as GitHubApp;

const started: string[] = [];
/** Like the real starter: a started scan records its workflow run, so it is never started twice. */
const deps = () => ({
  db: database,
  github: fakeGithub,
  startScan: async (id: string) => {
    if (await claimWorkflowStart(database, id, `run-${id}`)) started.push(id);
  },
});
let orgId = "";
const repoIds = new Map<number, string>();

const threatModelJson = { summary: "An API.", stack: [], entryPoints: [], authModel: "", trustBoundaries: [], sensitiveAssets: [], dangerousSinks: [], frameworkProtections: [], abuseSurfaces: [], subsystems: [] };

/** An open finding citing `src/db.ts`, and a threat model, so pushes to the repo queue fix checks. */
async function withOpenFinding(githubRepoId: number): Promise<void> {
  const repoId = repoIds.get(githubRepoId)!;
  await saveThreatModel(database, repoId, threatModelJson, "seed");
  const { scan } = await createScan(database, { repoId, orgId, kind: "deep", trigger: "manual", headSha: "seed" });
  await updateScan(database, scan.id, { status: "completed" });
  await upsertFindings(database, repoId, scan, [
    {
      fingerprint: `open-${githubRepoId}`,
      severity: "high",
      confidence: "high",
      category: "sql_injection",
      cwe: "CWE-89",
      title: "SQL injection",
      impact: "Reads every row.",
      entryPoint: { file: "src/api.ts", line: 1, description: "GET /x" },
      attackPath: [{ file: "src/db.ts", line: 3, note: "sink" }],
      attacker: "unauthenticated",
      preconditions: "None.",
      proofOfConcept: "GET /x?q='",
      fixGuidance: "Bind it.",
      guarantees: [],
      mustNotBreak: [],
      regressionTest: "Assert 400.",
      fixPrompt: "Fix it.",
    },
  ]);
}

const push = (githubRepoId: number, before: string, after: string, delivery: string) =>
  handleWebhook(deps(), "push", delivery, { ref: "refs/heads/main", before, after, installation: { id: 801 }, repository: repoList.find((r) => r.id === githubRepoId) });

const scansOf = (githubRepoId: number, kind: "recon" | "fix_check" | "pr_review") =>
  database.query.scans.findMany({ where: (s, { and, eq }) => and(eq(s.repoId, repoIds.get(githubRepoId)!), eq(s.kind, kind)), orderBy: (s, { asc }) => asc(s.createdAt) });

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
  Object.assign(process.env, { DATABASE_URL: url.toString(), GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "unused", GITHUB_WEBHOOK_SECRET: "unused", SANDCHEST_APP_URL: "https://sandchest.test", SANDCHEST_WORKSPACE: "local", SANDCHEST_GIT_HOST: "file:///nonexistent" });
  resetConfig();
  database = createDb(url.toString(), { max: 5 });
  await migrate(database);
  setServices({ db: database, github: fakeGithub });
  const { org, repos } = await upsertInstallation(
    database,
    801,
    { githubAccountId: 8001, githubLogin: "acme", type: "Organization" },
    repoList.map((r) => ({ githubRepoId: r.id, fullName: r.full_name, private: r.private, defaultBranch: r.default_branch })),
  );
  orgId = org.id;
  for (const repo of repos) repoIds.set(repo.githubRepoId, repo.id);
});

afterAll(async () => {
  if (!available) return;
  await database.$client.end();
  await admin!.unsafe(`drop database if exists ${NAME} with (force)`);
  await admin!.end();
});

const it = (name: string, fn: () => Promise<void>) => test(name, async () => (available ? fn() : console.warn(`skipped (no Postgres): ${name}`)));

describe("free scans from pushes", () => {
  it("folds a burst of pushes into the fix check still waiting, which then covers every push", async () => {
    await withOpenFinding(81);
    const before = started.length;
    for (let i = 1; i <= 5; i++) await push(81, `c${i - 1}`, `c${i}`, `burst-${i}`);
    const checks = await scansOf(81, "fix_check");
    expect(checks).toHaveLength(1);
    expect(started.length - before).toBe(1);
    // From before the first push to after the last: the one check sees every change.
    expect(checks[0]).toMatchObject({ baseSha: "c0", headSha: "c5", status: "queued" });
  });

  it("runs a repo's fix checks one at a time and at most once a minute, leaving the org's other slot free", async () => {
    await withOpenFinding(82);
    await push(82, "d0", "d1", "pace-1");
    const [first] = await scansOf(82, "fix_check");
    expect(await claimScanSlot(database, first!.id, orgId, 2)).toBe(true);
    // Pushes while it runs queue one more check, not one each.
    await push(82, "d1", "d2", "pace-2");
    await push(82, "d2", "d3", "pace-3");
    const checks = await scansOf(82, "fix_check");
    expect(checks).toHaveLength(2);
    const next = checks[1]!;
    expect(next).toMatchObject({ baseSha: "d1", headSha: "d3" });
    expect(await claimScanSlot(database, next.id, orgId, 2)).toBe(false);
    // A PR review still gets the org's second slot.
    const { scan: review } = await createScan(database, { repoId: repoIds.get(82)!, orgId, kind: "pr_review", trigger: "webhook", headSha: "pr1", prNumber: 1 });
    expect(await claimScanSlot(database, review.id, orgId, 2)).toBe(true);
    await updateScan(database, review.id, { status: "completed" });
    // Finished, but started under a minute ago: the next one still waits.
    await updateScan(database, first!.id, { status: "completed" });
    expect(await claimScanSlot(database, next.id, orgId, 2)).toBe(false);
    await database.$client`update scans set started_at = now() - interval '2 minutes' where id = ${first!.id}`;
    expect(await claimScanSlot(database, next.id, orgId, 2)).toBe(true);
    await updateScan(database, next.id, { status: "completed" });
  });

  it("queues one recon per repo, however many pushes come before it has a threat model, and at most one a day", async () => {
    await push(83, "e0", "e1", "recon-1");
    await push(83, "e1", "e2", "recon-2");
    await push(83, "e2", "e3", "recon-3");
    expect(await scansOf(83, "recon")).toHaveLength(1);
    // A recon that failed after doing its work is not rerun by every later push the same day.
    const [recon] = await scansOf(83, "recon");
    await updateScan(database, recon!.id, { status: "failed" });
    await push(83, "e3", "e4", "recon-4");
    expect(await scansOf(83, "recon")).toHaveLength(1);
    // A day on, the next push tries again.
    await database.$client`update scans set created_at = now() - interval '25 hours' where id = ${recon!.id}`;
    await push(83, "e4", "e5", "recon-5");
    expect(await scansOf(83, "recon")).toHaveLength(2);
  });

  it("ends a fix check whose push changed no cited file before cloning anything", async () => {
    await withOpenFinding(84);
    await push(84, "f0", "f1", "noclone-1");
    const [check] = await scansOf(84, "fix_check");
    await updateScan(database, check!.id, { status: "running" });
    const before = clones;
    expect(await executeScan(check!.id)).toEqual({ findings: 0 });
    expect(clones).toBe(before);
  });
});
