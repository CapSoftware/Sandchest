/**
 * The first deep scan, against a real Postgres with GitHub faked and billing
 * off (a self-hosted server, or local dev): joining starts it on the first
 * target, and it waits for that repository's recon to finish rather than
 * mapping the code again beside it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { createDb, dashboardRepos, feedSince, scanById, schema, updateOrgSettings, upsertInstallation, type Db } from "@sandchest/db";
import { migrate } from "@sandchest/db/migrate";
import type { GitHubApp } from "@sandchest/github";
import { setAutumn } from "@/server/billing";
import { resetConfig } from "@/server/config";
import { startFirstTarget } from "@/server/first-target";
import { beginScan } from "@/server/scans";
import { setServices } from "@/server/services";
import { setScanStarter } from "@/server/start";

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest";
const NAME = `sandchest_first_dig_test_${process.pid}`;

let admin: postgres.Sql | undefined;
let database: Db;
let available = true;
const started: string[] = [];
const fakeGithub = { installation: () => ({ branchSha: async () => "deadbeef" }) } as unknown as GitHubApp;

let userId: string;
let org: Awaited<ReturnType<typeof upsertInstallation>>["org"];
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
  Object.assign(process.env, { DATABASE_URL: url.toString(), GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "unused", GITHUB_WEBHOOK_SECRET: "unused", SANDCHEST_APP_URL: "https://sandchest.test" });
  resetConfig();
  database = createDb(url.toString(), { max: 5 });
  await migrate(database);
  setServices({ db: database, github: fakeGithub });
  setAutumn(undefined);
  setScanStarter(async (id) => void started.push(id));

  const [user] = await database.insert(schema.users).values({ name: "alice", email: "alice@example.com", login: "alice", githubUserId: 5101 }).returning();
  userId = user!.id;
  const installed = await upsertInstallation(database, 701, { githubAccountId: 9101, githubLogin: "acme", type: "Organization" }, [
    { githubRepoId: 81, fullName: "acme/api", private: true, defaultBranch: "main" },
    { githubRepoId: 82, fullName: "acme/web", private: true, defaultBranch: "main" },
  ]);
  org = installed.org;
  repoIds = installed.repos.map((repo) => repo.id);
  await database.insert(schema.orgAdmins).values({ userId, orgId: org.id });
  await database.insert(schema.permissionCache).values(repoIds.map((repoId) => ({ userId, repoId, permission: "admin" as const })));
});

afterAll(async () => {
  setScanStarter(undefined);
  if (!available) return;
  await database.$client.end();
  await admin!.unsafe(`drop database if exists ${NAME} with (force)`);
  await admin!.end();
});

const recon = async (repoId: string) => {
  const [scan] = await database.insert(schema.scans).values({ repoId, orgId: org.id, kind: "recon", trigger: "webhook", headSha: "HEAD" }).returning();
  return scan!.id;
};
const finish = (scanId: string) => database.$client`update scans set status = 'completed', finished_at = now() where id = ${scanId}`;
const deepScanned = (repoId: string, at: Date | null) => database.$client`update repos set last_deep_scan_at = ${at?.toISOString() ?? null} where id = ${repoId}`;
const orgRow = async () => (await database.query.orgs.findFirst({ where: (o, { eq }) => eq(o.id, org.id) }))!;

describe.skipIf(!available)("the first deep scan", () => {
  test("waits for its repository's recon, says so, then starts", async () => {
    const mapping = await recon(repoIds[0]!);
    await updateOrgSettings(database, userId, org.id, { firstTarget: repoIds[0]! });
    const row = await orgRow();

    const next = await startFirstTarget(userId, row);
    const deepId = next.replace("/dashboard/scans/", "");
    expect(await scanById(database, deepId)).toMatchObject({ kind: "deep", status: "queued" });
    expect(started).toContain(deepId);

    // Recon is queued: the deep scan waits, and its feed says why.
    expect((await beginScan(deepId)).state).toBe("queued");
    expect((await feedSince(database, deepId, 0)).events.map((e) => e.type)).toEqual(["queue:recon"]);
    // The dashboard says what it's waiting on.
    const waiting = async () => (await dashboardRepos(database, userId, { repoId: repoIds[0]! }))[0]!;
    expect(await waiting()).toMatchObject({ activeDeepScanId: deepId, activeDeepScanWaitsForRecon: true });
    expect((await feedSince(database, deepId, 0)).events[0]!.message).toContain("Waiting for recon to map acme/api");

    // Still waiting while the recon runs, without repeating itself.
    expect((await beginScan(mapping)).state).toBe("running");
    expect((await beginScan(deepId)).state).toBe("queued");
    expect((await feedSince(database, deepId, 0)).events).toHaveLength(1);

    await finish(mapping);
    expect((await waiting()).activeDeepScanWaitsForRecon).toBe(false);
    expect((await beginScan(deepId)).state).toBe("running");
    await finish(deepId);
  });

  test("another repository's recon doesn't hold it up", async () => {
    await recon(repoIds[1]!);
    await deepScanned(repoIds[0]!, null);
    const row = await orgRow();
    const deepId = (await startFirstTarget(userId, row)).replace("/dashboard/scans/", "");
    expect((await beginScan(deepId)).state).toBe("running");
    await finish(deepId);
  });

  test("a recon older than the wait holds nothing up: it may be stuck, so the deep scan maps the code itself", async () => {
    const stale = await recon(repoIds[0]!);
    await database.$client`update scans set created_at = now() - interval '31 minutes' where id = ${stale}`;
    await deepScanned(repoIds[0]!, null);
    const deepId = (await startFirstTarget(userId, await orgRow())).replace("/dashboard/scans/", "");
    expect((await dashboardRepos(database, userId, { repoId: repoIds[0]! }))[0]!.activeDeepScanWaitsForRecon).toBe(false);
    expect((await beginScan(deepId)).state).toBe("running");
    await finish(deepId);
    await finish(stale);
  });

  test("a target already deep scanned isn't scanned again on joining again", async () => {
    await deepScanned(repoIds[0]!, new Date());
    const row = await orgRow();
    const before = started.length;
    expect(await startFirstTarget(userId, row, "/dashboard?recruited=1")).toBe("/dashboard?recruited=1");
    expect(started).toHaveLength(before);
  });
});
