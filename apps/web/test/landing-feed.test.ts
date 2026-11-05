/**
 * The landing page's crawl: which advisories it picks from OSV's feeds, how
 * findings are reduced before anyone can see them, and the order the two
 * are shown in.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, type Db, recentFindingClasses, schema, upsertInstallation } from "@sandchest/db";
import { migrate } from "@sandchest/db/migrate";
import postgres from "postgres";
import { createSand, CRUMBLE, crumbleMask, keeps } from "@/lib/crawl-dither";
import { ago, interleave } from "@/components/live-crawl";
import { type FeedAdvisory, foundDay, pickAdvisories, recentChanges, toAdvisory, toFindings } from "@/server/feed";

const NOW = Date.parse("2026-11-05T19:00:00Z");

const advisory = (id: string, published: string): FeedAdvisory => ({
  kind: "advisory",
  id,
  summary: "Something bad",
  severity: "high",
  ecosystem: "npm",
  package: "pkg",
  published,
  url: `https://osv.dev/vulnerability/${id}`,
});

describe("recentChanges", () => {
  test("reads GitHub advisories changed in the last three days, newest first, once each, dropping a cut-off last line", () => {
    const csv = [
      "2026-11-05T18:30:05.022230281Z,MAL-2026-1",
      "2026-11-05T18:15:03.855488079Z,GHSA-aaaa-bbbb-cccc",
      "2026-11-05T18:00:04.058304856Z,GHSA-dddd-eeee-ffff",
      "2026-11-04T10:00:00.000000000Z,GHSA-aaaa-bbbb-cccc",
      "2026-11-01T00:00:00.000000000Z,GHSA-old0-old0-old0",
      "2026-11-05T17:00:00.0Z,GHSA-cut",
    ].join("\n");
    expect(recentChanges(csv, NOW)).toEqual([
      { id: "GHSA-aaaa-bbbb-cccc", modified: "2026-11-05T18:15:03.855488079Z" },
      { id: "GHSA-dddd-eeee-ffff", modified: "2026-11-05T18:00:04.058304856Z" },
    ]);
  });
});

describe("toAdvisory", () => {
  const record = {
    id: "GHSA-m5ph-mmg5-6w5h",
    aliases: ["CVE-2026-62300"],
    summary: "filecoin-pin: unbounded DAG pinning can exhaust server resources",
    published: "2026-11-05T18:07:00Z",
    affected: [{ package: { ecosystem: "npm", name: "filecoin-pin" } }],
    database_specific: { severity: "MODERATE" },
  };

  test("shows the CVE ID, the summary without the package's name, and the severity in Sandchest's words", () => {
    expect(toAdvisory(record, "npm")).toEqual({
      kind: "advisory",
      id: "CVE-2026-62300",
      summary: "Unbounded DAG pinning can exhaust server resources",
      severity: "medium",
      ecosystem: "npm",
      package: "filecoin-pin",
      published: "2026-11-05T18:07:00Z",
      url: "https://osv.dev/vulnerability/GHSA-m5ph-mmg5-6w5h",
    });
  });

  test("falls back to the advisory ID, and leaves out withdrawn or unsummarised records", () => {
    expect(toAdvisory({ ...record, aliases: [] }, "npm")?.id).toBe("GHSA-m5ph-mmg5-6w5h");
    expect(toAdvisory({ ...record, withdrawn: "2026-11-05T19:00:00Z" }, "npm")).toBeUndefined();
    expect(toAdvisory({ ...record, summary: undefined }, "npm")).toBeUndefined();
    expect(toAdvisory({ ...record, affected: [] }, "npm")).toBeUndefined();
  });
});

describe("pickAdvisories", () => {
  test("newly published first, one per ID, leaving out old records that were only edited when there are enough new ones", () => {
    const fresh = Array.from({ length: 9 }, (_, i) => advisory(`CVE-2026-${i}`, new Date(NOW - i * 3_600_000).toISOString()));
    const old = advisory("CVE-2025-1", "2026-07-01T00:00:00Z");
    const picked = pickAdvisories([old, ...fresh.slice().reverse(), fresh[0]!], NOW);
    expect(picked.map((a) => a.id)).toEqual(fresh.map((a) => a.id));
  });

  test("fills with older ones when too few are new", () => {
    const picked = pickAdvisories([advisory("CVE-2025-1", "2026-07-01T00:00:00Z"), advisory("CVE-2026-1", "2026-11-05T12:00:00Z")], NOW);
    expect(picked.map((a) => a.id)).toEqual(["CVE-2026-1", "CVE-2025-1"]);
  });
});

describe("toFindings", () => {
  const now = new Date(NOW);
  test("keeps only kind, severity and day: no title, code, repository or time of day", () => {
    const [finding] = toFindings([{ severity: "critical", category: "sql_injection", firstSeenAt: new Date(NOW - 2 * 86_400_000) }], now);
    expect(finding).toEqual({ kind: "finding", severity: "critical", title: "SQL injection", found: "2 days ago" });
  });

  test("merges repeats and leaves out the catch-all kind", () => {
    const at = new Date(NOW - 7 * 3_600_000);
    const rows = [
      { severity: "high" as const, category: "broken_access_control", firstSeenAt: at },
      { severity: "high" as const, category: "broken_access_control", firstSeenAt: at },
      { severity: "low" as const, category: "other", firstSeenAt: at },
      { severity: "critical" as const, category: "business_logic", firstSeenAt: at },
    ];
    expect(toFindings(rows, now).map((f) => f.title)).toEqual(["Broken access control", "Business logic flaw"]);
  });

  test("names the day in UTC", () => {
    expect(foundDay(new Date("2026-11-05T00:30:00Z"), now)).toBe("today");
    expect(foundDay(new Date("2026-11-04T23:30:00Z"), now)).toBe("yesterday");
    expect(foundDay(new Date("2026-11-01T12:00:00Z"), now)).toBe("4 days ago");
  });
});

describe("the crawl", () => {
  test("starts with a finding and puts one between every two advisories while both last", () => {
    const a = (n: number) => advisory(`A${n}`, "2026-11-05T00:00:00Z");
    const f = (n: number) => ({ kind: "finding" as const, severity: "high" as const, title: `F${n}`, found: "today" });
    const order = interleave({ advisories: [a(1), a(2), a(3), a(4), a(5)], findings: [f(1), f(2)] }).map((i) => (i.kind === "advisory" ? i.id : i.title));
    expect(order).toEqual(["F1", "A1", "A2", "F2", "A3", "A4", "A5"]);
    expect(interleave({ advisories: [], findings: [f(1)] })).toHaveLength(1);
  });

  test("says how long ago an advisory was published", () => {
    expect(ago("2026-11-05T18:59:30Z", NOW)).toBe("just now");
    expect(ago("2026-11-05T18:48:00Z", NOW)).toBe("12 min ago");
    expect(ago("2026-11-05T14:00:00Z", NOW)).toBe("5h ago");
    expect(ago("2026-11-02T19:00:00Z", NOW)).toBe("3 days ago");
  });

  test("the crumbling mask shows all the text low in the band, none high up, and agrees with keeps()", () => {
    const cols = 120;
    const rows = 100;
    const mask = crumbleMask(cols, rows);
    const share = (y: number) => mask.subarray(y * cols, (y + 1) * cols).reduce((n, v) => n + (v ? 1 : 0), 0) / cols;
    expect(share(Math.floor(rows * 0.8))).toBe(1);
    expect(share(Math.floor(rows * (CRUMBLE.gone - 0.05)))).toBe(0);
    const middle = share(Math.floor(rows * ((CRUMBLE.gone + CRUMBLE.from) / 2)));
    expect(middle).toBeGreaterThan(0.2);
    expect(middle).toBeLessThan(0.8);
    for (let y = 0; y < rows; y += 7) for (let x = 0; x < cols; x += 5) expect(keeps(x, y, rows)).toBe(mask[y * cols + x] === 255);
  });

  test("sand draws only palette colours or nothing, and a still frame is the same every time", () => {
    const frame = () => {
      const sand = createSand(80, 60);
      const out = new Uint8ClampedArray(80 * 60 * 4);
      sand.render(out, 0, 0);
      return out;
    };
    const a = frame();
    expect(frame()).toEqual(a);
    const alphas = new Set<number>();
    for (let i = 3; i < a.length; i += 4) alphas.add(a[i]!);
    expect([...alphas].every((v) => v === 0 || v === 255)).toBe(true);
    expect(alphas.has(255)).toBe(true);
  });
});

describe("recentFindingClasses, against a real Postgres", () => {
  const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest";
  const NAME = `sandchest_feed_test_${process.pid}`;
  let admin: postgres.Sql | undefined;
  let database: Db | undefined;

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
    database = createDb(url.toString(), { max: 2 });
    await migrate(database);
    const { repos } = await upsertInstallation(database, 1, { githubAccountId: 10, githubLogin: "acme", type: "Organization" }, [
      { githubRepoId: 1, fullName: "acme/api", private: true, defaultBranch: "main" },
    ]);
    const base = {
      repoId: repos[0]!.id,
      confidence: "high" as const,
      title: "A private title",
      impact: "x",
      entryPoint: {},
      attackPath: [],
      attacker: "any_user",
      preconditions: "x",
      proofOfConcept: "x",
      fixGuidance: "x",
      guarantees: [],
      mustNotBreak: [],
      regressionTest: "x",
      fixPrompt: "x",
      sourceKind: "deep" as const,
    };
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
    await database.insert(schema.findings).values([
      { ...base, fingerprint: "old", severity: "high", category: "ssrf", firstSeenAt: hoursAgo(30) },
      { ...base, fingerprint: "newer", severity: "critical", category: "sql_injection", firstSeenAt: hoursAgo(8) },
      { ...base, fingerprint: "too-new", severity: "low", category: "xss", firstSeenAt: hoursAgo(1) },
      { ...base, fingerprint: "dismissed", severity: "high", category: "csrf", status: "dismissed", firstSeenAt: hoursAgo(9) },
      { ...base, fingerprint: "unbacked", severity: "high", category: "xxe", trust: "unconfirmed", firstSeenAt: hoursAgo(10) },
      { ...base, fingerprint: "backed", severity: "medium", category: "open_redirect", trust: "corroborated", firstSeenAt: hoursAgo(11) },
    ]);
  });

  afterAll(async () => {
    if (!admin) return;
    await database?.$client.end();
    await admin.unsafe(`drop database if exists ${NAME} with (force)`);
    await admin.end();
  });

  test("newest first, only severity, kind and when; nothing younger than the delay, dismissed or unbacked", async () => {
    if (!database) return;
    const rows = await recentFindingClasses(database, { limit: 10, minAgeMs: 6 * 3_600_000 });
    expect(rows.map((r) => r.category)).toEqual(["sql_injection", "open_redirect", "ssrf"]);
    expect(Object.keys(rows[0]!).sort()).toEqual(["category", "firstSeenAt", "severity"]);
    expect(await recentFindingClasses(database, { limit: 1, minAgeMs: 6 * 3_600_000 })).toHaveLength(1);
  });
});
