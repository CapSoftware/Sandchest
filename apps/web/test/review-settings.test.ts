/**
 * A repository's review settings against a real Postgres, with GitHub faked:
 * scheduled deep scans start once when due, skip code that hasn't changed and
 * keep their rhythm; PR reviews never queue behind deep scans; a review that
 * failed can be run again; and only people who can push may change settings.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { claimScanSlot, createDb, createScan, schema, updateRepoSettings, updateScan, upsertInstallation, type Db } from "@sandchest/db";
import { migrate } from "@sandchest/db/migrate";
import type { GitHubApp } from "@sandchest/github";
import { addInterval, firstRun, nextRun } from "@/lib/schedule";
import { resetConfig } from "@/server/config";
import { runSchedules } from "@/server/schedule";
import { setServices } from "@/server/services";
import { setScanStarter } from "@/server/start";

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest";
const NAME = `sandchest_review_settings_test_${process.pid}`;

let admin: postgres.Sql | undefined;
let database: Db;
let available = true;

/** The default branch's head, as the fake GitHub reports it. */
let branchHead = "head-1";
const fakeGithub = { installation: () => ({ branchSha: async () => branchHead }) } as unknown as GitHubApp;
const started: string[] = [];
let orgId = "";
let repoId = "";
let otherRepoId = "";

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
  const { org, repos } = await upsertInstallation(database, 91, { githubAccountId: 910, githubLogin: "acme", type: "Organization" }, [
    { githubRepoId: 9101, fullName: "acme/api", private: true, defaultBranch: "main" },
    { githubRepoId: 9102, fullName: "acme/web", private: true, defaultBranch: "main" },
  ]);
  orgId = org.id;
  repoId = repos.find((r) => r.fullName === "acme/api")!.id;
  otherRepoId = repos.find((r) => r.fullName === "acme/web")!.id;
});

afterAll(async () => {
  setScanStarter(undefined);
  if (!available || !admin) return;
  await database.$client.end();
  await admin.unsafe(`drop database if exists ${NAME} with (force)`);
  await admin.end();
});

describe("schedule arithmetic", () => {
  test("monthly keeps the day of the month where it can", () => {
    expect(addInterval("monthly", new Date("2026-01-31T09:00:00Z")).toISOString()).toBe("2026-02-28T09:00:00.000Z");
    expect(addInterval("monthly", new Date("2026-03-15T09:00:00Z")).toISOString()).toBe("2026-04-15T09:00:00.000Z");
    expect(addInterval("weekly", new Date("2026-11-04T09:00:00Z")).toISOString()).toBe("2026-11-11T09:00:00.000Z");
  });

  test("the first run is an interval after the last deep scan, or now", () => {
    const now = new Date("2026-11-04T12:00:00Z");
    expect(firstRun("off", null, now)).toBeNull();
    expect(firstRun("weekly", null, now)).toEqual(now);
    expect(firstRun("weekly", new Date("2026-11-02T08:00:00Z"), now)?.toISOString()).toBe("2026-11-09T08:00:00.000Z");
    expect(firstRun("daily", new Date("2026-10-01T08:00:00Z"), now)).toEqual(now);
  });

  test("the next run keeps the rhythm, unless runs were missed", () => {
    const due = new Date("2026-11-04T08:00:00Z");
    expect(nextRun("daily", due, new Date("2026-11-04T08:05:00Z")).toISOString()).toBe("2026-11-05T08:00:00.000Z");
    expect(nextRun("daily", due, new Date("2026-11-07T10:00:00Z")).toISOString()).toBe("2026-11-08T10:00:00.000Z");
  });
});

describe("scheduled deep scans", () => {
  test("a due run starts one deep scan, once, and moves on to the next", async () => {
    if (!available) return;
    const due = new Date(Date.now() - 60_000);
    await database.$client`update repos set deep_scan_schedule = 'weekly', next_deep_scan_at = ${due.toISOString()} where id = ${repoId}`;
    // Two sweeps at once: only one starts it.
    const [a, b] = await Promise.all([runSchedules(), runSchedules()]);
    expect(a.started + b.started).toBe(1);
    const scans = await database.query.scans.findMany({ where: (scans, { eq }) => eq(scans.repoId, repoId) });
    expect(scans).toHaveLength(1);
    expect(scans[0]).toMatchObject({ kind: "deep", trigger: "schedule", headSha: "head-1" });
    expect(started).toContain(scans[0]!.id);
    const repo = await database.query.repos.findFirst({ where: (repos, { eq }) => eq(repos.id, repoId) });
    expect(repo!.nextDeepScanAt!.getTime()).toBe(addInterval("weekly", due).getTime());
    await updateScan(database, scans[0]!.id, { status: "completed" });
  });

  test("a run on code the last deep scan already read is skipped", async () => {
    if (!available) return;
    await database.$client`update repos set next_deep_scan_at = ${new Date(Date.now() - 1_000).toISOString()} where id = ${repoId}`;
    expect((await runSchedules()).started).toBe(0);
    expect(await database.query.scans.findMany({ where: (scans, { eq }) => eq(scans.repoId, repoId) })).toHaveLength(1);
    // New commits: the next run scans them.
    branchHead = "head-2";
    await database.$client`update repos set next_deep_scan_at = ${new Date(Date.now() - 1_000).toISOString()} where id = ${repoId}`;
    expect((await runSchedules()).started).toBe(1);
  });

  test("nothing runs when the schedule is off", async () => {
    if (!available) return;
    await database.$client`update repos set deep_scan_schedule = 'off', next_deep_scan_at = ${new Date(Date.now() - 1_000).toISOString()} where id = ${otherRepoId}`;
    expect((await runSchedules()).due).toBeLessThanOrEqual(1);
    expect(await database.query.scans.findMany({ where: (scans, { eq }) => eq(scans.repoId, otherRepoId) })).toHaveLength(0);
  });
});

describe("PR reviews", () => {
  test("a review gets a slot while deep scans hold the org's others", async () => {
    if (!available) return;
    const deep = await createScan(database, { repoId: otherRepoId, orgId, kind: "deep", trigger: "manual", headSha: "d1" });
    await updateScan(database, deep.scan.id, { status: "running" });
    const fix = await createScan(database, { repoId: otherRepoId, orgId, kind: "fix_check", trigger: "webhook", headSha: "f1" });
    await updateScan(database, fix.scan.id, { status: "running" });
    // The deep-scan lane is full …
    const waiting = await createScan(database, { repoId, orgId, kind: "fix_check", trigger: "webhook", headSha: "f2" });
    expect(await claimScanSlot(database, waiting.scan.id, orgId, 2)).toBe(false);
    // … and a review still starts.
    const review = await createScan(database, { repoId, orgId, kind: "pr_review", trigger: "webhook", headSha: "p1", prNumber: 3 });
    expect(await claimScanSlot(database, review.scan.id, orgId, 2)).toBe(true);
    for (const id of [deep.scan.id, fix.scan.id, review.scan.id]) await updateScan(database, id, { status: "completed" });
  });

  test("a head whose review failed can be reviewed again; a finished one can't", async () => {
    if (!available) return;
    const input = { repoId, orgId, kind: "pr_review" as const, trigger: "manual" as const, headSha: "p9", prNumber: 4 };
    const first = await createScan(database, input);
    expect(first.created).toBe(true);
    await updateScan(database, first.scan.id, { status: "failed" });
    const again = await createScan(database, input);
    expect(again.created).toBe(true);
    await updateScan(database, again.scan.id, { status: "completed" });
    const third = await createScan(database, input);
    expect(third).toMatchObject({ created: false, scan: { id: again.scan.id } });
  });
});

describe("who may change settings", () => {
  test("only people who can push to the repo", async () => {
    if (!available) return;
    const [user] = await database.insert(schema.users).values({ name: "Dev", email: "dev@example.com", login: "dev" }).returning();
    expect(await updateRepoSettings(database, user!.id, repoId, { prReviews: "off" })).toBe(false);
    await database.insert(schema.permissionCache).values({ userId: user!.id, repoId, permission: "write" });
    expect(await updateRepoSettings(database, user!.id, repoId, { prReviews: "command", deepScanSchedule: "off", nextDeepScanAt: null })).toBe(true);
    const repo = await database.query.repos.findFirst({ where: (repos, { eq }) => eq(repos.id, repoId) });
    expect(repo).toMatchObject({ prReviews: "command", deepScanSchedule: "off", nextDeepScanAt: null });
  });
});
