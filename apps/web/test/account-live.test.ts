import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { createDb, liveHistory, liveTail, liveCursorNow, schema, upsertInstallation, type Db, type LiveScan } from "@sandchest/db";
import { migrate } from "@sandchest/db/migrate";
import { addItems, FEED_KEEP, fromHistory, itemLabel, jobOf, scanItem, type FeedItem, type FeedJob } from "@/lib/account-feed";
import { LiveHub, liveResponse } from "@/server/account-live";

const scan = (patch: Partial<LiveScan> = {}): LiveScan => ({
  id: "00000000-0000-4000-8000-000000000001",
  orgId: "org",
  repoId: "repo",
  repo: "acme/api",
  kind: "pr_review",
  status: "queued",
  prNumber: 42,
  createdAt: "2026-11-06T10:00:00Z",
  startedAt: null,
  finishedAt: null,
  found: null,
  ...patch,
});

describe("the feed's items", () => {
  test("a scan arriving, starting and ending says so once each, and nothing when it hasn't moved", () => {
    expect(scanItem(scan(), null)).toMatchObject({ kind: "queued", id: `s:${scan().id}:queued` });
    expect(scanItem(scan({ status: "running", startedAt: "2026-11-06T10:01:00Z" }), "queued")).toMatchObject({ kind: "started", at: Date.parse("2026-11-06T10:01:00Z") });
    expect(scanItem(scan({ status: "running" }), "running")).toBeNull();
    // Running to publishing is the same job, carrying on.
    expect(scanItem(scan({ status: "publishing" }), "running")).toBeNull();
    expect(scanItem(scan({ status: "completed", found: 2, finishedAt: "2026-11-06T10:05:00Z" }), "publishing")).toMatchObject({ kind: "done", text: "Done: 2 findings" });
    expect(scanItem(scan({ status: "completed", found: 0 }), "running")!.text).toBe("Done: nothing exploitable");
    expect(scanItem(scan({ status: "failed" }), "running")).toMatchObject({ kind: "failed", text: "Failed" });
    expect(itemLabel(scanItem(scan(), null)!)).toBe("PR review");
  });

  test("the feed keeps the newest FEED_KEEP, never the same item twice, and stays the same list when nothing is new", () => {
    const item = (n: number): FeedItem => ({ id: `l:${n}`, at: n, kind: "line", repoId: "r", repo: "acme/api", text: `line ${n}` });
    let feed: FeedItem[] = [];
    for (let n = 1; n <= 1000; n += 10) feed = addItems(feed, Array.from({ length: 10 }, (_, i) => item(n + i)));
    expect(feed.length).toBe(FEED_KEEP);
    expect(feed[0]!.at).toBe(1000);
    expect(new Set(feed.map((i) => i.id)).size).toBe(FEED_KEEP);
    // Repeats (a reconnect's overlap) change nothing, and give back the very same list.
    expect(addItems(feed, [item(1000), item(999)])).toBe(feed);
    expect(addItems(feed, [])).toBe(feed);
  });

  test("a job knows its step from its stage lines, a deep scan's track included", () => {
    const job = jobOf(scan({ kind: "deep", status: "running", prNumber: null }), ["stage:setup", "stage:index", "progress", "stage:hunt"], "auth: following the cookie", 1);
    expect(job).toMatchObject({ step: "Hunt", steps: 7, done: 4, line: "auth: following the cookie", found: 1 });
    expect(jobOf(scan(), [], null, 0)).toMatchObject({ step: null, done: 0 });
  });
});

/** Every item and job one viewer gets. */
function collector() {
  const items: FeedItem[] = [];
  const jobs: Array<FeedJob | { id: string; gone: true }> = [];
  return { items, jobs, item: (i: FeedItem) => items.push(i), job: (j: FeedJob | { id: string; gone: true }) => jobs.push(j) };
}

const until = async (check: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe("the live feed, against a real Postgres", () => {
  const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest";
  const NAME = `sandchest_live_test_${process.pid}`;
  let admin: postgres.Sql | undefined;
  let database: Db | undefined;
  let orgId = "";
  let api = "";
  let web = "";
  let alice = "";
  let bob = "";

  beforeAll(async () => {
    try {
      admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
      await admin.unsafe(`create database ${NAME}`);
    } catch {
      admin = undefined;
      return;
    }
    const url = new URL(ADMIN_URL);
    url.pathname = `/${NAME}`;
    database = createDb(url.toString(), { max: 4 });
    await migrate(database);
    const { org, repos } = await upsertInstallation(database, 1, { githubAccountId: 10, githubLogin: "acme", type: "Organization" }, [
      { githubRepoId: 100, fullName: "acme/api", private: true, defaultBranch: "main" },
      { githubRepoId: 101, fullName: "acme/web", private: true, defaultBranch: "main" },
    ]);
    orgId = org.id;
    api = repos[0]!.id;
    web = repos[1]!.id;
    const users = await database.insert(schema.users).values([{ name: "A", email: "a@example.com", emailVerified: true }, { name: "B", email: "b@example.com", emailVerified: true }]).returning();
    alice = users[0]!.id;
    bob = users[1]!.id;
    // Alice can see both repositories; Bob only acme/web.
    await database.insert(schema.permissionCache).values([
      { userId: alice, repoId: api, permission: "write" },
      { userId: alice, repoId: web, permission: "write" },
      { userId: bob, repoId: web, permission: "write" },
    ]);
  });

  afterAll(async () => {
    await database?.$client.end();
    if (admin) {
      await admin.unsafe(`drop database if exists ${NAME} with (force)`);
      await admin.end();
    }
  });

  const newScan = async (repoId: string, kind: "pr_review" | "deep" = "pr_review") => {
    const [row] = await database!.insert(schema.scans).values({ repoId, orgId, kind, status: "queued", trigger: "webhook", headSha: crypto.randomUUID().replaceAll("-", "").padEnd(40, "0"), prNumber: kind === "pr_review" ? 7 : null }).returning();
    return row!.id;
  };
  let seq = 0;
  const line = (scanId: string, type: string, message: string) => database!.insert(schema.scanEvents).values({ scanId, seq: ++seq, type, message });

  test("a tail read returns only what's new, and its cursor picks up exactly where it stopped", async () => {
    if (!database) return;
    const start = await liveCursorNow(database);
    const id = await newScan(api);
    await line(id, "stage:setup", "Setting up");
    await line(id, "progress", "auth: looking");
    const first = await liveTail(database, start, []);
    expect(first.lines.map((l) => l.message)).toEqual(["Setting up", "auth: looking"]);
    expect(first.scans.map((s) => s.id)).toContain(id);
    expect(first.cursor.line).toBe(first.lines.at(-1)!.id);
    const again = await liveTail(database, first.cursor, []);
    expect(again.lines).toEqual([]);
    // A scan asked after is read whatever happens to it.
    expect((await liveTail(database, first.cursor, [id])).scans.map((s) => s.id)).toEqual([id]);
    // A bounded read takes the first lines and leaves the rest for the next one.
    for (let i = 0; i < 5; i++) await line(id, "progress", `more ${i}`);
    const part = await liveTail(database, first.cursor, [], 3);
    expect(part.lines.map((l) => l.message)).toEqual(["more 0", "more 1", "more 2"]);
    expect((await liveTail(database, part.cursor, [], 3)).lines.map((l) => l.message)).toEqual(["more 3", "more 4"]);
  });

  test("history shows each person only the repositories they can see", async () => {
    if (!database) return;
    const theirs = await newScan(web);
    await line(theirs, "finding", "Bob can see this");
    const forBob = await liveHistory(database, bob, orgId);
    expect(forBob.scans.every((s) => s.repoId === web)).toBe(true);
    expect(forBob.lines.map((l) => l.message)).toContain("Bob can see this");
    const forAlice = await liveHistory(database, alice, orgId);
    expect(new Set(forAlice.scans.map((s) => s.repoId))).toEqual(new Set([api, web]));
    const everyone = fromHistory(await liveHistory(database, null, orgId));
    expect(everyone.jobs.length).toBeGreaterThanOrEqual(2);
  });

  test("one poller serves every viewer, each only their own repositories, and stops when they go", async () => {
    if (!database) return;
    const hub = new LiveHub({ busyMs: 50, quietMs: 50, cveMs: 60_000, historyMs: 0, database: () => database! });
    const a = collector();
    const b = collector();
    const stopA = hub.watch({ orgId, repos: new Set([api, web]), ...a });
    const stopB = hub.watch({ orgId, repos: new Set([web]), ...b });
    expect(hub.polling).toBe(true);
    // Let the poller take its starting cursor before anything happens.
    await new Promise((r) => setTimeout(r, 200));

    const mine = await newScan(api, "deep");
    await until(() => a.items.some((i) => i.kind === "queued" && i.scan?.id === mine));
    await database.$client`update scans set status = 'running', started_at = now() where id = ${mine}`;
    await line(mine, "stage:hunt", "Hunting");
    await line(mine, "finding", "Something real");
    await until(() => a.items.some((i) => i.kind === "finding"));
    await database.$client`update scans set status = 'completed', finished_at = now(), stats = '{"findingIds":["x"]}'::jsonb where id = ${mine}`;
    await until(() => a.items.some((i) => i.kind === "done"));

    expect(a.items.filter((i) => i.scan?.id === mine).map((i) => i.kind)).toEqual(["queued", "started", "stage", "finding", "done"]);
    expect(a.items.find((i) => i.kind === "done")!.text).toBe("Done: 1 finding");
    const last = a.jobs.filter((j) => j.id === mine);
    expect(last.at(-1)).toEqual({ id: mine, gone: true });
    expect(last.some((j) => "step" in j && j.step === "Hunt")).toBe(true);
    // Bob can't see acme/api: nothing of it reached him.
    expect(b.items.some((i) => i.repoId === api)).toBe(false);
    expect(b.jobs.some((j) => j.id === mine)).toBe(false);

    const shared = await newScan(web);
    await until(() => b.items.some((i) => i.scan?.id === shared) && a.items.some((i) => i.scan?.id === shared));

    stopA();
    stopB();
    await new Promise((r) => setTimeout(r, 150));
    expect(hub.polling).toBe(false);
  });

  test("a stream opens with the jobs running and what came before, then follows along; leaving releases it", async () => {
    if (!database) return;
    const hub = new LiveHub({ busyMs: 50, quietMs: 50, cveMs: 60_000, historyMs: 0, database: () => database! });
    const going = await newScan(web);
    await database.$client`update scans set status = 'running', started_at = now() where id = ${going}`;
    await line(going, "stage:index", "Indexing");
    const leave = new AbortController();
    const response = liveResponse(new Request("http://localhost/x", { signal: leave.signal }), bob, orgId, new Set([web]), null, () => hub);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const readUntil = async (pattern: RegExp) => {
      while (!pattern.test(text)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
    };
    await readUntil(/event: opening\ndata: .*\n\n/);
    const opening = JSON.parse(/event: opening\ndata: (.*)\n\n/.exec(text)![1]!) as { jobs: FeedJob[]; items: FeedItem[] };
    expect(opening.jobs.map((j) => j.id)).toContain(going);
    expect(opening.jobs.find((j) => j.id === going)!.step).toBe("Index");
    expect(opening.items.every((i) => i.repoId === web)).toBe(true);

    await new Promise((r) => setTimeout(r, 200));
    await line(going, "progress", "web: following the redirect");
    await readUntil(/following the redirect/);
    expect(text).toMatch(/id: \d+\nevent: item\ndata: .*following the redirect/);

    leave.abort();
    await new Promise((r) => setTimeout(r, 150));
    expect(hub.polling).toBe(false);
    // Released: the same person can open as many again as before.
    const many = Array.from({ length: 8 }, () => new AbortController());
    const opened = many.map((c) => liveResponse(new Request("http://localhost/x", { signal: c.signal }), bob, orgId, new Set([web]), null, () => hub));
    expect(opened.every((r) => r.status === 200)).toBe(true);
    expect(liveResponse(new Request("http://localhost/x"), bob, orgId, new Set([web]), null, () => hub).status).toBe(429);
    many.forEach((c) => c.abort());
    await new Promise((r) => setTimeout(r, 150));
  });
});
