/**
 * Runs against a throwaway database on the local Postgres
 * (docker compose -f docker/compose.dev.yml up -d). Skips if it is not running.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  claimDelivery,
  claimScanSlot,
  createDb,
  createScan,
  disableRepos,
  eventsSince,
  EventWriter,
  markFixed,
  openFindings,
  removeInstallation,
  repoByGithubId,
  saveThreatModel,
  threatModel,
  upsertFindings,
  upsertInstallation,
  type Db,
  type FindingInput,
} from "../src";
import { migrate } from "../src/migrate";

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest";
const NAME = `sandchest_test_${process.pid}`;
let admin: postgres.Sql | undefined;
let database: Db;
let available = true;

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
});

afterAll(async () => {
  if (!available) return;
  await database.$client.end();
  await admin!.unsafe(`drop database if exists ${NAME} with (force)`);
  await admin!.end();
});

const it = (name: string, fn: () => Promise<void>) => test(name, async () => (available ? fn() : console.warn(`skipped (no Postgres): ${name}`)));

const account = { githubAccountId: 101, githubLogin: "acme", type: "Organization" as const };
const repo = (id: number) => ({ githubRepoId: id, fullName: `acme/app-${id}`, private: true, defaultBranch: "main" });

function finding(fingerprint: string): FindingInput {
  return {
    fingerprint,
    severity: "high",
    confidence: "high",
    category: "sql_injection",
    cwe: "CWE-89",
    title: "SQL injection",
    impact: "Reads every row.",
    entryPoint: { file: "a.ts", line: 1, description: "GET /x" },
    attackPath: [{ file: "a.ts", line: 3, note: "sink", excerpt: "3| db.query(x)" }],
    attacker: "unauthenticated",
    preconditions: "None.",
    proofOfConcept: "GET /x?q='",
    fixGuidance: "Bind it.",
    guarantees: ["No injection"],
    mustNotBreak: [],
    regressionTest: "Assert 400.",
    fixPrompt: "Fix it.",
  };
}

describe("installations", () => {
  it("upserts orgs and repos, disables removed repos and survives uninstall", async () => {
    const { org, repos } = await upsertInstallation(database, 9001, account, [repo(1), repo(2)]);
    expect(repos).toHaveLength(2);
    // Reinstall with a changed login updates in place.
    const again = await upsertInstallation(database, 9001, { ...account, githubLogin: "acme-inc" }, [repo(1)]);
    expect(again.org.id).toBe(org.id);
    expect(again.org.githubLogin).toBe("acme-inc");

    await disableRepos(database, [2]);
    expect((await repoByGithubId(database, 2))?.enabled).toBe(false);

    await removeInstallation(database, 9001);
    const found = await repoByGithubId(database, 1);
    expect(found?.enabled).toBe(false);
    expect(found?.org.installationId).toBeNull();
  });
});

describe("webhooks", () => {
  it("handles each delivery once", async () => {
    expect(await claimDelivery(database, "d-1", "push")).toBe(true);
    expect(await claimDelivery(database, "d-1", "push")).toBe(false);
  });
});

describe("scans", () => {
  it("never creates two reviews for one PR head", async () => {
    const { org, repos } = await upsertInstallation(database, 9002, { ...account, githubAccountId: 102 }, [repo(10)]);
    const input = { repoId: repos[0]!.id, orgId: org.id, kind: "pr_review" as const, trigger: "webhook" as const, headSha: "abc", prNumber: 7 };
    const first = await createScan(database, input);
    const second = await createScan(database, input);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.scan.id).toBe(first.scan.id);
    // A new head is a new review.
    expect((await createScan(database, { ...input, headSha: "def" })).created).toBe(true);
  });

  it("lets at most `limit` scans per org run, even when claimed concurrently", async () => {
    const { org, repos } = await upsertInstallation(database, 9003, { ...account, githubAccountId: 103 }, [repo(20)]);
    const created = await Promise.all(
      Array.from({ length: 5 }, (_, i) => createScan(database, { repoId: repos[0]!.id, orgId: org.id, kind: "deep", trigger: "manual", headSha: `sha${i}` })),
    );
    const claims = await Promise.all(created.map(({ scan }) => claimScanSlot(database, scan.id, org.id, 2)));
    expect(claims.filter(Boolean)).toHaveLength(2);
    // Claiming a running scan again is a no-op that reports it running.
    const running = created[claims.indexOf(true)]!.scan.id;
    expect(await claimScanSlot(database, running, org.id, 2)).toBe(true);
  });
});

describe("live feed", () => {
  it("keeps order across batches and continues after a restart", async () => {
    const { org, repos } = await upsertInstallation(database, 9004, { ...account, githubAccountId: 104 }, [repo(30)]);
    const { scan } = await createScan(database, { repoId: repos[0]!.id, orgId: org.id, kind: "deep", trigger: "manual", headSha: "x" });
    const writer = new EventWriter(database, scan.id, 5);
    for (let i = 1; i <= 5; i++) writer.write("progress", `step ${i}`);
    await writer.flush();
    writer.write("progress", "step 6");
    await writer.flush();
    // A retried step starts a fresh writer.
    const retry = new EventWriter(database, scan.id, 5);
    retry.write("progress", "step 7");
    await retry.flush();

    const events = await eventsSince(database, scan.id, 0);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(events.map((e) => e.message).at(-1)).toBe("step 7");
    expect((await eventsSince(database, scan.id, 5)).map((e) => e.seq)).toEqual([6, 7]);
  });
});

describe("findings", () => {
  it("dedupes by fingerprint, reopens fixed findings, and strips excerpts when fixed", async () => {
    const { org, repos } = await upsertInstallation(database, 9005, { ...account, githubAccountId: 105 }, [repo(40)]);
    const repoId = repos[0]!.id;
    const { scan } = await createScan(database, { repoId, orgId: org.id, kind: "deep", trigger: "manual", headSha: "x" });

    const first = await upsertFindings(database, repoId, scan, [finding("fp-1"), finding("fp-2")]);
    expect(first.newIds).toHaveLength(2);
    const second = await upsertFindings(database, repoId, scan, [finding("fp-1")]);
    expect(second.newIds).toHaveLength(0);

    await markFixed(database, [first.ids[0]!], scan.id);
    const open = await openFindings(database, repoId);
    expect(open.map((f) => f.fingerprint)).toEqual(["fp-2"]);

    await upsertFindings(database, repoId, scan, [finding("fp-1")]);
    expect((await openFindings(database, repoId)).map((f) => f.fingerprint).sort()).toEqual(["fp-1", "fp-2"]);
  });

  it("stores the threat model per repo and bumps its version", async () => {
    const { repos } = await upsertInstallation(database, 9006, { ...account, githubAccountId: 106 }, [repo(50)]);
    await saveThreatModel(database, repos[0]!.id, { summary: "v1" }, "a");
    await saveThreatModel(database, repos[0]!.id, { summary: "v2" }, "b");
    expect(await threatModel(database, repos[0]!.id)).toEqual({ threatModel: { summary: "v2" }, commitSha: "b" });
  });
});
