/**
 * The CVE directory against a real Postgres, with OSV faked: an inventory is
 * matched the moment it is read, an upgrade resolves what it fixed, a new
 * advisory reaches every repository that installs the package through the
 * change feed, a withdrawn one goes away, two OSV records of one bug are one
 * entry, nobody sees a repository they can't, and a push that changes a
 * lockfile asks for a fresh inventory.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { claimInventoryRefresh, createDb, cveCoverage, cveForUser, dashboardCves, inventoriesDue, releaseInventoryRefresh, requestInventory, saveThreatModel, schema, upsertInstallation, type Db } from "@sandchest/db";
import { migrate } from "@sandchest/db/migrate";
import type { Change, OsvCatalog, OsvRecord, PackageVersion } from "@sandchest/engine/advisories";
import type { GitHubApp } from "@sandchest/github";
import { resetConfig } from "@/server/config";
import { checkRepository, saveDependencies, syncAdvisories } from "@/server/cves";
import { setServices } from "@/server/services";
import { operationByName } from "@/server/agent/registry";
import { handleWebhook } from "@/server/webhooks";

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest";
const NAME = `sandchest_cves_test_${process.pid}`;

let admin: postgres.Sql | undefined;
let database: Db;
let available = true;

/** A tiny OSV: records, which versions each affects, and a change feed. */
class FakeOsv implements OsvCatalog {
  records = new Map<string, OsvRecord>();
  affects = new Map<string, Array<{ ecosystem: string; name: string; versions: string[] }>>();
  feed: Array<{ ecosystem: string; change: Change }> = [];
  calls = { matches: 0, records: 0 };

  add(record: OsvRecord, ecosystem: string, name: string, versions: string[]): void {
    this.records.set(record.id, { ...record, affected: [{ package: { ecosystem, name }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "99.0.0" }] }] }] });
    this.affects.set(record.id, [{ ecosystem, name, versions }]);
  }

  publish(id: string, ecosystem: string, at: Date): void {
    const modified = at.toISOString();
    this.records.set(id, { ...this.records.get(id)!, modified });
    this.feed.unshift({ ecosystem, change: { id, modified } });
  }

  async matches(packages: PackageVersion[]): Promise<Change[][]> {
    this.calls.matches++;
    return packages.map((pkg) =>
      [...this.affects.entries()]
        .filter(([id, list]) => !this.records.get(id)?.withdrawn && list.some((a) => a.ecosystem === pkg.ecosystem && a.name === pkg.name && a.versions.includes(pkg.version)))
        .map(([id]) => ({ id, modified: this.records.get(id)!.modified })),
    );
  }

  async record(id: string): Promise<OsvRecord | undefined> {
    this.calls.records++;
    return this.records.get(id);
  }

  async changedSince(ecosystem: string, since: number): Promise<{ changes: Change[]; complete: boolean }> {
    return { changes: this.feed.filter((f) => f.ecosystem === ecosystem && Date.parse(f.change.modified) >= since).map((f) => f.change), complete: true };
  }
}

const osv = new FakeOsv();
const fakeGithub = {} as GitHubApp;
let apiId = "";
let webId = "";
let userId = "";
let outsiderId = "";

const T0 = new Date("2026-11-01T10:00:00Z");

type Dep = Parameters<typeof saveDependencies>[3][number];
const dep = (over: Partial<Dep>): Dep => ({ ecosystem: "npm", name: "next", version: "15.0.0", manifest: "package-lock.json", direct: true, dev: false, reachability: "imported", importedAt: ["src/app/page.tsx:1"], ...over });

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
  setServices({ db: database, github: fakeGithub, catalog: osv });

  const { repos } = await upsertInstallation(database, 71, { githubAccountId: 710, githubLogin: "acme", type: "Organization" }, [
    { githubRepoId: 7101, fullName: "acme/api", private: true, defaultBranch: "main" },
    { githubRepoId: 7102, fullName: "acme/web", private: true, defaultBranch: "main" },
  ]);
  apiId = repos.find((r) => r.fullName === "acme/api")!.id;
  webId = repos.find((r) => r.fullName === "acme/web")!.id;
  const [user, outsider] = await database
    .insert(schema.users)
    .values([
      { name: "Dev", email: "dev@example.com" },
      { name: "Other", email: "other@example.com" },
    ])
    .returning();
  userId = user!.id;
  outsiderId = outsider!.id;
  await database.insert(schema.permissionCache).values([
    { userId, repoId: apiId, permission: "write" },
    { userId, repoId: webId, permission: "write" },
  ]);

  // next@15.0.0 has a critical RCE (GitHub's record) and a duplicate PYSEC-style record of the same CVE.
  osv.add({ id: "GHSA-next-rce", modified: "2026-10-01T00:00:00Z", published: "2026-09-01T00:00:00Z", aliases: ["CVE-2026-1000"], summary: "Remote code execution in image optimizer", database_specific: { severity: "CRITICAL" } }, "npm", "next", ["15.0.0"]);
  osv.add({ id: "OTHER-2026-1", modified: "2026-10-01T00:00:00Z", aliases: ["CVE-2026-1000", "GHSA-next-rce"], summary: "duplicate record" }, "npm", "next", ["15.0.0"]);
  // A medium one in a package only another package pulls in.
  osv.add({ id: "GHSA-lodash-proto", modified: "2026-10-01T00:00:00Z", aliases: ["CVE-2025-2000"], summary: "Prototype pollution", database_specific: { severity: "MODERATE" } }, "npm", "lodash", ["4.17.20"]);
  // A Go record with no rating of its own, whose GitHub alias has one.
  osv.records.set("GHSA-go-rated", { id: "GHSA-go-rated", modified: "2026-10-01T00:00:00Z", aliases: ["CVE-2025-3000"], database_specific: { severity: "HIGH" } });
  osv.add({ id: "GO-2025-1", modified: "2026-10-01T00:00:00Z", aliases: ["CVE-2025-3000", "GHSA-go-rated"], summary: "HTTP/2 rapid reset" }, "Go", "golang.org/x/net", ["0.17.0"]);
});

afterAll(async () => {
  if (!available || !admin) return;
  await database.$client.end();
  await admin.unsafe(`drop database if exists ${NAME} with (force)`);
  await admin.end();
});

describe("CVE directory", () => {
  test("an inventory is matched as soon as it is read, one entry per vulnerability, closest to shipped code first", async () => {
    if (!available) return;
    await saveDependencies(apiId, "sha-1", T0, [
      dep({}),
      dep({ name: "lodash", version: "4.17.20", direct: false, reachability: "not_imported", importedAt: [] }),
      dep({ ecosystem: "Go", name: "golang.org/x/net", version: "0.17.0", manifest: "go.mod", importedAt: ["cmd/server/main.go:5"] }),
    ]);
    const { list, counts } = await dashboardCves(database, userId);
    expect(counts).toEqual({ in_code: 2, installed: 1, resolved: 0 });
    expect(list.map((item) => [item.key, item.severity])).toEqual([
      ["CVE-2026-1000", "critical"],
      ["CVE-2025-3000", "high"],
    ]);
    const next = list[0]!;
    expect(next.primary.id).toBe("GHSA-next-rce");
    expect(next.ids.sort()).toEqual(["GHSA-next-rce", "OTHER-2026-1"]);
    expect(next.matches).toHaveLength(1);
    expect(next.matches[0]).toMatchObject({ repoFullName: "acme/api", name: "next", version: "15.0.0", usage: "product", importedAt: ["src/app/page.tsx:1"], commitSha: "sha-1" });
    // Rated from its GitHub alias, though OSV only matched the Go record.
    expect(list[1]!.primary.id).toBe("GO-2025-1");

    const installed = await dashboardCves(database, userId, { state: "installed" });
    expect(installed.list.map((item) => [item.key, item.matches[0]!.usage])).toEqual([["CVE-2025-2000", "none"]]);
  });

  test("looking one up by CVE id, advisory id or alias finds the same entry; the full record comes with it", async () => {
    if (!available) return;
    for (const key of ["CVE-2026-1000", "GHSA-next-rce", "OTHER-2026-1"]) {
      const found = await cveForUser(database, userId, key);
      expect(found?.item.key).toBe("CVE-2026-1000");
      expect(found?.advisory.summary).toBe("Remote code execution in image optimizer");
    }
    expect(await cveForUser(database, userId, "CVE-1999-0001")).toBeUndefined();
  });

  test("agents ask the same questions: list_cves and get_cve, with links and an upgrade prompt", async () => {
    if (!available) return;
    const context = (user: string) => ({ principal: { userId: user, login: "dev", name: "Dev", githubUserId: 1, tokenId: "t", tokenKind: "key" as const, accessCheckedAt: new Date() }, surface: "api" as const, appUrl: "https://sandchest.test" });
    const list = (await operationByName("list_cves")!.run(context(userId), { query: "CVE-2026-1000" })) as { cves: Array<{ id: string; matches: Array<{ in_code: boolean }> }> };
    expect(list.cves.map((c) => c.id)).toEqual(["CVE-2026-1000"]);
    expect(list.cves[0]!.matches[0]!.in_code).toBe(true);
    const one = (await operationByName("get_cve")!.run(context(userId), { id: "GHSA-next-rce" })) as {
      id: string;
      matches: Array<{ imported_at: Array<{ url: string }>; fixed_in: string | null }>;
      upgrade_prompts: Array<{ repo: string; prompt: string }>;
    };
    expect(one.id).toBe("CVE-2026-1000");
    expect(one.matches[0]!.imported_at[0]!.url).toBe("https://github.com/acme/api/blob/sha-1/src/app/page.tsx#L1");
    expect(one.matches[0]!.fixed_in).toBe("99.0.0");
    expect(one.upgrade_prompts[0]!.repo).toBe("acme/api");
    expect(one.upgrade_prompts[0]!.prompt).toContain("next@15.0.0");
    await expect(operationByName("get_cve")!.run(context(outsiderId), { id: "CVE-2026-1000" })).rejects.toThrow("doesn't affect");
  });

  test("nobody sees a repository they can't push to", async () => {
    if (!available) return;
    const { list, counts } = await dashboardCves(database, outsiderId);
    expect(list).toHaveLength(0);
    expect(counts).toEqual({ in_code: 0, installed: 0, resolved: 0 });
    expect(await cveForUser(database, outsiderId, "CVE-2026-1000")).toBeUndefined();
  });

  test("filters: severity, repository and search", async () => {
    if (!available) return;
    expect((await dashboardCves(database, userId, { severities: ["high"] })).list.map((i) => i.key)).toEqual(["CVE-2025-3000"]);
    expect((await dashboardCves(database, userId, { repoId: webId })).counts).toEqual({ in_code: 0, installed: 0, resolved: 0 });
    expect((await dashboardCves(database, userId, { query: "golang.org/x" })).list.map((i) => i.key)).toEqual(["CVE-2025-3000"]);
    expect((await dashboardCves(database, userId, { query: "ghsa-next-rce" })).list.map((i) => i.key)).toEqual(["CVE-2026-1000"]);
  });

  test("an inventory read before the stored one is dropped", async () => {
    if (!available) return;
    const { saved } = await saveDependencies(apiId, "sha-0", new Date(T0.getTime() - 60_000), [dep({ version: "14.0.0" })]);
    expect(saved).toBe(false);
    expect((await dashboardCves(database, userId)).counts.in_code).toBe(2);
  });

  test("upgrading resolves what the new version fixes, and only that", async () => {
    if (!available) return;
    await saveDependencies(apiId, "sha-2", new Date(T0.getTime() + 60_000), [
      dep({ version: "15.5.3" }),
      dep({ name: "lodash", version: "4.17.20", direct: false, reachability: "not_imported", importedAt: [] }),
      dep({ ecosystem: "Go", name: "golang.org/x/net", version: "0.17.0", manifest: "go.mod", importedAt: ["cmd/server/main.go:5"] }),
    ]);
    const { counts } = await dashboardCves(database, userId);
    expect(counts).toEqual({ in_code: 1, installed: 1, resolved: 1 });
    const resolved = await dashboardCves(database, userId, { state: "resolved" });
    expect(resolved.list[0]!.key).toBe("CVE-2026-1000");
    expect(resolved.list[0]!.matches[0]!.resolvedAt).not.toBeNull();
  });

  test("a new advisory reaches every repository installing the package through the change feed, flagged new", async () => {
    if (!available) return;
    await saveDependencies(webId, "sha-w1", T0, [dep({ name: "lodash", version: "4.17.20", importedAt: ["lib/merge.ts:2"] })]);
    const now = new Date("2026-11-05T12:00:00Z");
    // Each ecosystem's feed is followed from the first inventory installing from it.
    expect((await database.select().from(schema.advisoryFeeds)).map((f) => f.ecosystem).sort()).toEqual(["Go", "npm"]);
    osv.add({ id: "GHSA-lodash-new", modified: "x", published: "2026-11-05T11:30:00Z", aliases: ["CVE-2026-4000"], summary: "Command injection in template", database_specific: { severity: "HIGH" } }, "npm", "lodash", ["4.17.20"]);
    osv.publish("GHSA-lodash-new", "npm", new Date("2026-11-05T11:55:00Z"));
    const result = await syncAdvisories();
    expect(result.errors).toEqual([]);
    expect(result.added.map((m) => [m.advisoryId, m.repoId === apiId ? "api" : "web"]).sort()).toEqual([
      ["GHSA-lodash-new", "api"],
      ["GHSA-lodash-new", "web"],
    ]);
    const found = await cveForUser(database, userId, "CVE-2026-4000", now);
    expect(found?.item.fresh).toBe(true);
    // Imported by shipped code in acme/web, pulled in by another package in acme/api.
    expect(found?.item.state).toBe("in_code");
    expect(found?.item.matches.map((m) => [m.repoFullName, m.usage])).toEqual([
      ["acme/web", "product"],
      ["acme/api", "none"],
    ]);
    // Syncing again with nothing new changes nothing.
    expect((await syncAdvisories()).added).toEqual([]);
  });

  test("a withdrawn advisory is resolved everywhere at the next feed sync", async () => {
    if (!available) return;
    const at = new Date("2026-11-05T12:20:00Z");
    osv.records.set("GHSA-lodash-new", { ...osv.records.get("GHSA-lodash-new")!, withdrawn: at.toISOString() });
    osv.publish("GHSA-lodash-new", "npm", at);
    await syncAdvisories();
    const found = await cveForUser(database, userId, "CVE-2026-4000");
    // Withdrawn records leave the directory entirely.
    expect(found).toBeUndefined();
    const rows = await database.select().from(schema.repoAdvisories);
    expect(rows.filter((r) => r.advisoryId === "GHSA-lodash-new").every((r) => r.resolvedAt !== null)).toBe(true);
  });

  test("the daily full check finds what the feed missed, without fetching unchanged records again", async () => {
    if (!available) return;
    osv.add({ id: "GHSA-missed", modified: "2026-10-02T00:00:00Z", aliases: [], summary: "Missed by the feed", database_specific: { severity: "LOW" } }, "npm", "lodash", ["4.17.20"]);
    const before = osv.calls.records;
    const added = await checkRepository(webId, "feed");
    expect(added.map((m) => m.advisoryId)).toEqual(["GHSA-missed"]);
    expect(osv.calls.records - before).toBe(1);
    const coverage = await cveCoverage(database, userId);
    expect(coverage).toMatchObject({ repos: 2, inventoried: 2 });
    expect(coverage.checkedAt).not.toBeNull();
  });

  test("a push changing a lockfile asks for a fresh inventory; one that doesn't, doesn't", async () => {
    if (!available) return;
    await saveThreatModel(database, webId, { summary: "x" } as never, "sha-w1");
    const started: string[] = [];
    const deps = { db: database, github: fakeGithub, startScan: async () => {}, startInventory: async (id: string) => void started.push(id) };
    const push = (id: string, files: string[]) => ({ ref: "refs/heads/main", before: "a", after: "b", repository: { id: 7102, full_name: "acme/web", default_branch: "main" }, installation: { id: 71 }, commits: [{ modified: files }] });
    await handleWebhook(deps, "push", "d-1", push("d-1", ["src/index.ts"]));
    expect(started).toEqual([]);
    await handleWebhook(deps, "push", "d-2", push("d-2", ["apps/web/package.json", "bun.lock"]));
    expect(started).toEqual([webId]);
    expect(await inventoriesDue(database, 10)).toEqual([webId]);
  });

  test("a refresh that keeps failing backs off, gives up, and starts over on the next push", async () => {
    if (!available) return;
    const due = async () => (await inventoriesDue(database, 10)).includes(webId);
    expect(await due()).toBe(true);
    expect(await claimInventoryRefresh(database, webId)).toBe(true);
    expect(await due()).toBe(false);
    await releaseInventoryRefresh(database, webId, "clone failed");
    // Just failed: waits 20 minutes.
    expect(await due()).toBe(false);
    const age = async (failures: number, minutes: number) =>
      database.$client`update repo_inventories set failures = ${failures}, failed_at = now() - make_interval(mins => ${minutes}) where repo_id = ${webId}`;
    await age(1, 25);
    expect(await due()).toBe(true);
    await age(3, 70);
    expect(await due()).toBe(false);
    await age(3, 90);
    expect(await due()).toBe(true);
    await age(6, 100_000);
    expect(await due()).toBe(false);
    await requestInventory(database, webId);
    expect(await due()).toBe(true);
    // Success clears the count.
    expect(await claimInventoryRefresh(database, webId)).toBe(true);
    await releaseInventoryRefresh(database, webId);
    const [row] = await database.$client`select failures, error, failed_at from repo_inventories where repo_id = ${webId}`;
    expect([row!.failures, row!.error, row!.failed_at]).toEqual([0, null, null]);
  });
});
