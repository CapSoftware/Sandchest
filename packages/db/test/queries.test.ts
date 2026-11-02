/**
 * Runs against a throwaway database on the local Postgres
 * (docker compose -f docker/compose.dev.yml up -d). Skips if it is not running.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  claimDelivery,
  claimWorkflowStart,
  releaseWorkflowStart,
  strandedScans,
  updateScan,
  claimScanSlot,
  feedSince,
  noteScanEvent,
  createDb,
  createScan,
  disableRepos,
  eventsSince,
  EventWriter,
  markFixed,
  openFindings,
  removeInstallation,
  repoHistory,
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

  it("deletes the code findings quote when a repo is removed, then on uninstall", async () => {
    const { org, repos } = await upsertInstallation(database, 9011, { ...account, githubAccountId: 111 }, [repo(11), repo(12)]);
    const { scan } = await createScan(database, { repoId: repos[0]!.id, orgId: org.id, kind: "deep", trigger: "manual", headSha: "x" });
    for (const r of repos) await upsertFindings(database, r.id, scan, [{ ...finding(`code-${r.githubRepoId}`), fixPrompt: "quotes 3| db.query(x)" }]);
    const quoted = async (repoId: string) => {
      const [row] = await database.$client<Array<{ attack_path: Array<{ excerpt?: string }>; fix_prompt: string; title: string }>>`select attack_path, fix_prompt, title from findings where repo_id = ${repoId}`;
      return { excerpt: row!.attack_path[0]!.excerpt, prompt: row!.fix_prompt, title: row!.title };
    };

    await disableRepos(database, [12]);
    expect(await quoted(repos[1]!.id)).toEqual({ excerpt: undefined, prompt: "", title: "SQL injection" });
    // The repo still installed keeps its code until the app goes.
    expect((await quoted(repos[0]!.id)).excerpt).toBe("3| db.query(x)");

    await removeInstallation(database, 9011);
    expect(await quoted(repos[0]!.id)).toEqual({ excerpt: undefined, prompt: "", title: "SQL injection" });
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

  it("lets exactly one caller start a scan's workflow, and lets it retry after a failed start", async () => {
    const { org, repos } = await upsertInstallation(database, 9007, { ...account, githubAccountId: 107 }, [repo(60)]);
    const { scan } = await createScan(database, { repoId: repos[0]!.id, orgId: org.id, kind: "deep", trigger: "manual", headSha: "z" });
    const claims = await Promise.all(Array.from({ length: 5 }, (_, i) => claimWorkflowStart(database, scan.id, `c${i}`)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const winner = `c${claims.indexOf(true)}`;
    await releaseWorkflowStart(database, scan.id, "someone-else");
    expect(await claimWorkflowStart(database, scan.id, "late")).toBe(false);
    await releaseWorkflowStart(database, scan.id, winner);
    expect(await claimWorkflowStart(database, scan.id, "retry")).toBe(true);
  });

  it("allows one active deep scan per repo, and a new one once it has finished", async () => {
    const { org, repos } = await upsertInstallation(database, 9016, { ...account, githubAccountId: 116 }, [repo(80)]);
    const dig = (sha: string) => createScan(database, { repoId: repos[0]!.id, orgId: org.id, kind: "deep", trigger: "manual", headSha: sha });
    const [a, b] = await Promise.all([dig("one"), dig("two")]);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(a.scan.id).toBe(b.scan.id);
    await updateScan(database, a.scan.id, { status: "completed" });
    const next = await dig("three");
    expect(next.created).toBe(true);
    expect(next.scan.id).not.toBe(a.scan.id);
  });

  it("finds scans that never started and scans stuck past their budget", async () => {
    const { org, repos } = await upsertInstallation(database, 9008, { ...account, githubAccountId: 108 }, [repo(70)]);
    const make = (sha: string) => createScan(database, { repoId: repos[0]!.id, orgId: org.id, kind: "recon", trigger: "webhook", headSha: sha });
    const { scan: lost } = await make("lost");
    const { scan: stuck } = await make("stuck");
    const { scan: fine } = await make("fine");
    await updateScan(database, stuck.id, { status: "running" });
    await database.$client`update scans set started_at = now() - interval '2 hours' where id = ${stuck.id}`;
    await updateScan(database, fine.id, { workflowRunId: "run-1" });

    const later = new Date(Date.now() + 10 * 60_000);
    const { unstarted, stuck: stuckScans } = await strandedScans(database, later);
    expect(unstarted.map((s) => s.id)).toContain(lost.id);
    expect(unstarted.map((s) => s.id)).not.toContain(fine.id);
    expect(stuckScans.map((s) => s.id)).toEqual([stuck.id]);
  });

  it("lets at most `limit` scans per org run, even when claimed concurrently", async () => {
    const { org, repos } = await upsertInstallation(database, 9003, { ...account, githubAccountId: 103 }, [repo(20)]);
    const created = await Promise.all(
      Array.from({ length: 5 }, (_, i) => createScan(database, { repoId: repos[0]!.id, orgId: org.id, kind: "recon", trigger: "webhook", headSha: `sha${i}` })),
    );
    const claims = await Promise.all(created.map(({ scan }) => claimScanSlot(database, scan.id, org.id, 2)));
    expect(claims.filter(Boolean)).toHaveLength(2);
    // Claiming a running scan again is a no-op that reports it running.
    const running = created[claims.indexOf(true)]!.scan.id;
    expect(await claimScanSlot(database, running, org.id, 2)).toBe(true);
  });
  it("gives recon its own lane, so a Dig never waits behind it", async () => {
    const { org, repos } = await upsertInstallation(database, 9013, { ...account, githubAccountId: 113 }, [repo(21), repo(22), repo(23)]);
    const make = (i: number, kind: "recon" | "deep") => createScan(database, { repoId: repos[i % 3]!.id, orgId: org.id, kind, trigger: "manual", headSha: `lane${i}` });
    const recons = await Promise.all([0, 1, 2].map((i) => make(i, "recon")));
    const claims = await Promise.all(recons.map(({ scan }) => claimScanSlot(database, scan.id, org.id, 2)));
    expect(claims.filter(Boolean)).toHaveLength(2);
    // Both recon slots are taken, and a deep scan still starts at once.
    const { scan: deep } = await make(0, "deep");
    expect(await claimScanSlot(database, deep.id, org.id, 2)).toBe(true);
    // The third recon still waits: its lane is full.
    expect(await claimScanSlot(database, recons[claims.indexOf(false)]!.scan.id, org.id, 2)).toBe(false);
  });

  it("notes why a scan waits once, not on every poll, and reports when it started", async () => {
    const { org, repos } = await upsertInstallation(database, 9014, { ...account, githubAccountId: 114 }, [repo(24)]);
    const { scan } = await createScan(database, { repoId: repos[0]!.id, orgId: org.id, kind: "deep", trigger: "manual", headSha: "note" });
    for (let i = 0; i < 3; i++) await noteScanEvent(database, scan.id, "queue", "Waiting for a free slot.");
    await noteScanEvent(database, scan.id, "queue", "Waiting for a free slot: 2 running.");
    const first = await feedSince(database, scan.id, 0);
    expect(first.events.map((e) => [e.seq, e.type, e.message])).toEqual([
      [1, "queue", "Waiting for a free slot."],
      [2, "queue", "Waiting for a free slot: 2 running."],
    ]);
    expect(first).toMatchObject({ status: "queued", startedAt: null });
    expect(await claimScanSlot(database, scan.id, org.id, 2)).toBe(true);
    const started = await feedSince(database, scan.id, 2);
    expect(started.status).toBe("running");
    expect(Date.parse(started.startedAt!)).toBeGreaterThan(Date.now() - 60_000);
    expect(await feedSince(database, "00000000-0000-0000-0000-000000000000", 0)).toEqual({ status: null, startedAt: null, events: [] });
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

  it("stamps each event when it happened, not when its batch was written", async () => {
    const { org, repos } = await upsertInstallation(database, 9014, { ...account, githubAccountId: 114 }, [repo(31)]);
    const { scan } = await createScan(database, { repoId: repos[0]!.id, orgId: org.id, kind: "deep", trigger: "manual", headSha: "x" });
    const writer = new EventWriter(database, scan.id, 1_000);
    writer.write("stage", "first");
    await new Promise((resolve) => setTimeout(resolve, 40));
    writer.write("stage", "second");
    await writer.flush();
    const [first, second] = await eventsSince(database, scan.id, 0);
    expect(second!.createdAt.getTime() - first!.createdAt.getTime()).toBeGreaterThanOrEqual(30);
  });
});

describe("findings", () => {
  it("stores no code from a scan that finishes after Sandchest lost access", async () => {
    const { org, repos } = await upsertInstallation(database, 9017, { ...account, githubAccountId: 117 }, [repo(52), repo(53)]);
    const { scan } = await createScan(database, { repoId: repos[0]!.id, orgId: org.id, kind: "deep", trigger: "manual", headSha: "x" });
    const withPrompt = (fp: string) => ({ ...finding(fp), fixPrompt: "quotes 3| db.query(x)" });
    const code = async (repoId: string) => {
      const [row] = await database.$client<Array<{ fix_prompt: string; attack_path: Array<{ excerpt?: string }> }>>`select fix_prompt, attack_path from findings where repo_id = ${repoId}`;
      return { excerpt: row!.attack_path[0]!.excerpt, prompt: row!.fix_prompt };
    };
    // The repo is removed from the installation while its scan runs, then the scan saves its findings.
    await disableRepos(database, [53]);
    await upsertFindings(database, repos[1]!.id, scan, [withPrompt("late-removed")]);
    expect(await code(repos[1]!.id)).toEqual({ excerpt: undefined, prompt: "" });
    // The app is uninstalled while another scan runs.
    await removeInstallation(database, 9017);
    await upsertFindings(database, repos[0]!.id, scan, [withPrompt("late-uninstalled")]);
    expect(await code(repos[0]!.id)).toEqual({ excerpt: undefined, prompt: "" });
  });

  it("never gives a dismissed finding its code back when a scan finds it again", async () => {
    const { org, repos } = await upsertInstallation(database, 9015, { ...account, githubAccountId: 115 }, [repo(51)]);
    const repoId = repos[0]!.id;
    const { scan } = await createScan(database, { repoId, orgId: org.id, kind: "deep", trigger: "manual", headSha: "x" });
    const withPrompt = { ...finding("fp-dismissed"), fixPrompt: "quotes 3| db.query(x)" };
    const [id] = (await upsertFindings(database, repoId, scan, [withPrompt])).ids;
    // Dismissing deletes the code (as applyFindingAction does).
    await database.$client`update findings set status = 'dismissed', dismiss_reason = 'accepted_risk', fix_prompt = '', attack_path = (select jsonb_agg(step - 'excerpt') from jsonb_array_elements(attack_path) step) where id = ${id!}`;

    await upsertFindings(database, repoId, scan, [withPrompt]);
    const [row] = await database.$client<Array<{ status: string; fix_prompt: string; attack_path: Array<{ file: string; line: number; note: string; excerpt?: string }> }>>`select status, fix_prompt, attack_path from findings where id = ${id!}`;
    expect(row!.status).toBe("dismissed");
    expect(row!.fix_prompt).toBe("");
    expect(row!.attack_path[0]).toEqual({ file: "a.ts", line: 3, note: "sink" });
  });

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

  it("refreshes evidence on re-seen findings and unions the signals that raised them", async () => {
    const { org, repos } = await upsertInstallation(database, 9020, { ...account, githubAccountId: 120 }, [repo(60)]);
    const repoId = repos[0]!.id;
    const { scan } = await createScan(database, { repoId, orgId: org.id, kind: "deep", trigger: "manual", headSha: "x" });
    await upsertFindings(database, repoId, scan, [{ ...finding("fp-ev"), trust: "unconfirmed", sources: ["hunter"], mitigations: "" }]);
    await upsertFindings(database, repoId, scan, [{ ...finding("fp-ev"), trust: "corroborated", sources: ["missing_check"], mitigations: "Rate limited." }]);
    const [row] = await database.$client<Array<{ trust: string; sources: string[]; mitigations: string }>>`select trust, sources, mitigations from findings where repo_id = ${repoId} and fingerprint = 'fp-ev'`;
    expect(row).toEqual({ trust: "corroborated", sources: ["hunter", "missing_check"], mitigations: "Rate limited." });
  });

  it("returns a repo's resolved findings with the team's verdict, and nothing open", async () => {
    const { org, repos } = await upsertInstallation(database, 9021, { ...account, githubAccountId: 121 }, [repo(61)]);
    const repoId = repos[0]!.id;
    const { scan } = await createScan(database, { repoId, orgId: org.id, kind: "deep", trigger: "manual", headSha: "x" });
    const { ids } = await upsertFindings(database, repoId, scan, [finding("h-fixed"), finding("h-fp"), finding("h-open")]);
    await markFixed(database, [ids[0]!], scan.id);
    await database.$client`update findings set status = 'dismissed', dismiss_reason = 'false_positive' where id = ${ids[1]!}`;

    const history = await repoHistory(database, repoId);
    expect(history.map((h) => h.outcome).sort()).toEqual(["false_positive", "fixed"]);
    expect(history[0]).toMatchObject({ title: "SQL injection", category: "sql_injection", at: "a.ts:3" });
  });

  it("stores the threat model per repo and bumps its version", async () => {
    const { repos } = await upsertInstallation(database, 9006, { ...account, githubAccountId: 106 }, [repo(50)]);
    await saveThreatModel(database, repos[0]!.id, { summary: "v1" }, "a");
    await saveThreatModel(database, repos[0]!.id, { summary: "v2" }, "b");
    expect(await threatModel(database, repos[0]!.id)).toEqual({ threatModel: { summary: "v2" }, commitSha: "b" });
  });
});
