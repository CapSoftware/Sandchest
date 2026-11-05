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
  test("reads well-formed GitHub advisory IDs changed in the last three days, newest first, once each, dropping a cut-off last line", () => {
    const csv = [
      "2026-11-05T18:30:05.022230281Z,MAL-2026-1",
      "2026-11-05T18:15:03.855488079Z,GHSA-f2fc-vc88-6w7q",
      "2026-11-05T18:00:04.058304856Z,GHSA-rxjr-6c9q-h67x",
      "2026-11-04T10:00:00.000000000Z,GHSA-f2fc-vc88-6w7q",
      "2026-11-04T09:00:00.000000000Z,GHSA-not-a-real-id",
      "2026-11-04T08:00:00.000000000Z,GHSA-../../x",
      "2026-11-01T00:00:00.000000000Z,GHSA-mgrx-3hqw-485h",
      "2026-11-05T17:00:00.0Z,GHSA-m5ph-mmg5-6w",
    ].join("\n");
    expect(recentChanges(csv, NOW)).toEqual([
      { id: "GHSA-f2fc-vc88-6w7q", modified: "2026-11-05T18:15:03.855488079Z" },
      { id: "GHSA-rxjr-6c9q-h67x", modified: "2026-11-05T18:00:04.058304856Z" },
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
      published: "2026-11-05T18:07:00.000Z",
      url: "https://osv.dev/vulnerability/GHSA-m5ph-mmg5-6w5h",
    });
  });

  test("falls back to the advisory ID, and leaves out withdrawn or unsummarised records", () => {
    expect(toAdvisory({ ...record, aliases: [] }, "npm")?.id).toBe("GHSA-m5ph-mmg5-6w5h");
    expect(toAdvisory({ ...record, withdrawn: "2026-11-05T19:00:00Z" }, "npm")).toBeUndefined();
    expect(toAdvisory({ ...record, summary: undefined }, "npm")).toBeUndefined();
    expect(toAdvisory({ ...record, affected: [] }, "npm")).toBeUndefined();
  });

  test("checks everything it passes on: the ID asked for, a known ecosystem, real dates and CVE IDs, plain text of bounded length", () => {
    expect(toAdvisory(record, "npm", "GHSA-f2fc-vc88-6w7q")).toBeUndefined();
    expect(toAdvisory({ ...record, id: "javascript:alert(1)" }, "npm", "javascript:alert(1)")).toBeUndefined();
    expect(toAdvisory(record, "Evil")).toBeUndefined();
    expect(toAdvisory({ ...record, published: "soon" }, "npm")).toBeUndefined();
    expect(toAdvisory({ ...record, aliases: ["CVE-2026-1 <img src=x>", "PYSEC-1"] }, "npm")?.id).toBe("GHSA-m5ph-mmg5-6w5h");
    const noisy = toAdvisory(
      { ...record, summary: `Bad\u0000thing\u202e here\n\t${"word ".repeat(80)}`, affected: [{ package: { ecosystem: "x", name: `pkg\u2066${"a".repeat(300)}` } }] },
      "npm",
    )!;
    expect(noisy.summary.startsWith("Bad thing here word")).toBe(true);
    expect(noisy.summary.length).toBeLessThanOrEqual(160);
    expect(noisy.package.length).toBeLessThanOrEqual(100);
    expect(/[\u0000-\u001f\u202e\u2066]/.test(noisy.summary + noisy.package)).toBe(false);
    expect(noisy.ecosystem).toBe("npm");
    expect(Object.keys(noisy).sort()).toEqual(["ecosystem", "id", "kind", "package", "published", "severity", "summary", "url"]);
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
    expect(toFindings(rows, now).map((f) => f.title)).toEqual(["Business logic flaw", "Broken access control"]);
  });

  test("passes on only the engine's own kinds and severities, so no free text reaches the page", () => {
    const at = new Date(NOW - 7 * 3_600_000);
    const rows = [
      { severity: "high", category: "<script>alert(1)</script>", firstSeenAt: at },
      { severity: "urgent", category: "xss", firstSeenAt: at },
      { severity: "low", category: "xss", firstSeenAt: at },
    ];
    expect(toFindings(rows, now)).toEqual([{ kind: "finding", severity: "low", title: "Cross-site scripting", found: "today" }]);
  });

  test("within a day, orders by severity and kind, never by when each was found", () => {
    const rows = [
      { severity: "low", category: "xss", firstSeenAt: new Date(NOW - 7 * 3_600_000) },
      { severity: "critical", category: "ssrf", firstSeenAt: new Date(NOW - 8 * 3_600_000) },
      { severity: "critical", category: "csrf", firstSeenAt: new Date(NOW - 9 * 3_600_000) },
      { severity: "high", category: "xss", firstSeenAt: new Date(NOW - 30 * 3_600_000) },
    ];
    expect(toFindings(rows, now).map((f) => `${f.severity} ${f.title} ${f.found}`)).toEqual([
      "critical Cross-site request forgery today",
      "critical Server-side request forgery today",
      "low Cross-site scripting today",
      "high Cross-site scripting yesterday",
    ]);
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
  const OPTIONS = { limit: 50, minAgeMs: 6 * 3_600_000, maxAgeDays: 30, minOrgs: 3 };
  let admin: postgres.Sql | undefined;
  let database: Db | undefined;
  /** Noon UTC, `days` ago: well clear of the delay and of day boundaries. */
  const noon = (days: number) => {
    const d = new Date();
    d.setUTCHours(12, 0, 0, 0);
    return new Date(d.getTime() - days * 86_400_000);
  };

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
    const repoOf: string[] = [];
    for (const [i, login] of ["acme", "globex", "initech", "umbrella"].entries()) {
      const { repos } = await upsertInstallation(database, i + 1, { githubAccountId: 10 + i, githubLogin: login, type: "Organization" }, [
        { githubRepoId: 100 + i, fullName: `${login}/api`, private: true, defaultBranch: "main" },
      ]);
      repoOf.push(repos[0]!.id);
    }
    const base = {
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
    let n = 0;
    const row = (org: number, at: Date, severity: "critical" | "high" | "medium" | "low", category: string, extra: Record<string, unknown> = {}) => ({
      ...base,
      repoId: repoOf[org]!,
      fingerprint: `f${n++}`,
      severity,
      category,
      firstSeenAt: at,
      ...extra,
    });
    await database.insert(schema.findings).values([
      // Two days ago: three orgs, so shown.
      row(0, noon(2), "critical", "sql_injection"),
      row(1, noon(2), "high", "ssrf"),
      row(2, noon(2), "medium", "open_redirect", { trust: "corroborated" }),
      // The same day, but dismissed or unbacked: never shown, and not counted.
      row(3, noon(2), "high", "csrf", { status: "dismissed" }),
      row(3, noon(2), "high", "xxe", { trust: "unconfirmed" }),
      // Three days ago: only two orgs, so the whole day is held back.
      row(0, noon(3), "high", "xss"),
      row(1, noon(3), "low", "path_traversal"),
      // Four days ago: three orgs, but one of them only through a dismissed finding.
      row(0, noon(4), "high", "race_condition"),
      row(1, noon(4), "high", "race_condition"),
      row(2, noon(4), "high", "csrf", { status: "dismissed" }),
      // Long ago: three orgs, but past the window.
      row(0, noon(40), "low", "xss"),
      row(1, noon(40), "low", "xss"),
      row(2, noon(40), "low", "xss"),
      // Just now, from four orgs: too new.
      ...[0, 1, 2, 3].map((org) => row(org, new Date(Date.now() - 3_600_000), "critical", "hardcoded_secret")),
    ]);
  });

  afterAll(async () => {
    if (!admin) return;
    await database?.$client.end();
    await admin.unsafe(`drop database if exists ${NAME} with (force)`);
    await admin.end();
  });

  test("only days with findings from enough orgs, older than the delay, inside the window; never dismissed or unbacked ones", async () => {
    if (!database) return;
    const rows = await recentFindingClasses(database, OPTIONS);
    expect(rows.map((r) => r.category).sort()).toEqual(["open_redirect", "sql_injection", "ssrf"]);
  });

  test("returns severity, kind and when, nothing else: no org, repository, title or ID", async () => {
    if (!database) return;
    const rows = await recentFindingClasses(database, OPTIONS);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(["category", "firstSeenAt", "severity"]);
      expect(r.firstSeenAt).toBeInstanceOf(Date);
    }
    expect(await recentFindingClasses(database, { ...OPTIONS, limit: 1 })).toHaveLength(1);
    expect(await recentFindingClasses(database, { ...OPTIONS, minOrgs: 4 })).toHaveLength(0);
  });
});
