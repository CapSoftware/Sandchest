import { describe, expect, test } from "bun:test";
import { affectedNames, createOsvCatalog, cvss3Score, fixedVersion, packageKey, scoreSeverity, stampMs, toAdvisoryRecord, toInventory, type OsvRecord } from "../src/advisories";
import type { Dependency } from "../src/scan/tools";

describe("cvss3Score", () => {
  // Reference scores from the FIRST calculator.
  const cases: Array<[string, number]> = [
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", 9.8],
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H", 10],
    ["CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:N/A:N", 4.3],
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N", 6.1],
    ["CVSS:3.0/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:N/A:N", 5.9],
    ["CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H", 7.8],
    ["CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:C/C:L/I:L/A:N", 5.5],
    ["CVSS:3.1/AV:P/AC:H/PR:H/UI:R/S:U/C:N/I:N/A:L", 1.6],
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N", 0],
  ];
  for (const [vector, score] of cases) test(vector, () => expect(cvss3Score(vector)).toBe(score));

  test("rejects other versions and malformed vectors", () => {
    expect(cvss3Score("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N")).toBeNull();
    expect(cvss3Score("CVSS:3.1/AV:N/AC:L")).toBeNull();
    expect(cvss3Score("AV:N/AC:L/Au:N/C:P/I:P/A:P")).toBeNull();
  });

  test("ratings", () => {
    expect([9.8, 7, 6.9, 4, 3.9, 0.1, 0].map(scoreSeverity)).toEqual(["critical", "high", "medium", "medium", "low", "low", "none"]);
  });
});

const GHSA: OsvRecord = {
  id: "GHSA-aaaa-bbbb-cccc",
  modified: "2026-11-05T17:45:07.862674764Z",
  published: "2026-10-01T00:00:00Z",
  aliases: ["GHSA-zzzz-zzzz-zzzz", "CVE-2026-1234"],
  summary: "Path traversal in static file handler",
  details: "### Summary\nA request with `../` reads files.",
  severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N" }],
  affected: [
    {
      package: { ecosystem: "npm", name: "serve-thing" },
      ranges: [
        { type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.4.2" }, { introduced: "2.0.0" }, { fixed: "2.1.1" }] },
        { type: "GIT", events: [{ introduced: "abc" }] },
      ],
    },
  ],
  references: [{ type: "ADVISORY", url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc" }, { type: "WEB", url: "javascript:alert(1)" }, { type: "WEB" }],
  database_specific: { severity: "MODERATE" },
};

describe("toAdvisoryRecord", () => {
  test("keeps the advisory's own rating over its vector, CVE ids first, safe links only", () => {
    const record = toAdvisoryRecord(GHSA);
    expect(record.severity).toBe("medium");
    expect(record.score).toBe(7.5);
    expect(record.aliases).toEqual(["CVE-2026-1234", "GHSA-zzzz-zzzz-zzzz"]);
    expect(record.references).toEqual([{ type: "ADVISORY", url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc" }]);
    expect(record.affected).toEqual([{ ecosystem: "npm", name: "serve-thing", ranges: [{ introduced: "0", fixed: "1.4.2" }, { introduced: "2.0.0", fixed: "2.1.1" }] }]);
    expect(record.withdrawnAt).toBeNull();
  });

  test("rates by the vector when there is no label, and a malicious package as critical", () => {
    expect(toAdvisoryRecord({ ...GHSA, database_specific: undefined }).severity).toBe("high");
    expect(toAdvisoryRecord({ ...GHSA, database_specific: undefined, severity: undefined }).severity).toBe("unknown");
    const mal = toAdvisoryRecord({ id: "MAL-2026-1", modified: "2026-11-05T00:00:00Z", details: "", affected: [{ package: { ecosystem: "npm", name: "evil-pkg" } }] });
    expect(mal.malicious).toBe(true);
    expect(mal.severity).toBe("critical");
    expect(mal.summary).toBe("Malicious package");
  });

  test("summary falls back to the first line of prose in the details", () => {
    expect(toAdvisoryRecord({ ...GHSA, summary: undefined }).summary).toBe("A request with `../` reads files.");
  });
});

describe("fixedVersion", () => {
  const record = toAdvisoryRecord(GHSA);
  test("suggests the fix on the installed release line", () => {
    expect(fixedVersion(record, "npm", "serve-thing", "2.0.5")).toBe("2.1.1");
    expect(fixedVersion(record, "npm", "serve-thing", "1.0.0")).toBe("1.4.2");
    expect(fixedVersion(record, "npm", "other", "1.0.0")).toBeUndefined();
  });
});

test("packageKey normalises PyPI names", () => {
  expect(packageKey("PyPI", "Django_REST.framework")).toBe("django-rest-framework");
  expect(packageKey("npm", "@Scope/Pkg")).toBe("@scope/pkg");
});

test("stampMs reads nanosecond timestamps", () => {
  expect(stampMs("2026-11-05T17:45:07.862674764Z")).toBe(Date.UTC(2026, 10, 5, 17, 45, 7, 862));
  expect(stampMs("2026-11-05T17:45:07Z")).toBe(Date.UTC(2026, 10, 5, 17, 45, 7));
  expect(stampMs("not a date")).toBeNull();
});

describe("catalog", () => {
  test("reads the feed in byte ranges, joins lines split across them, and stops at the cursor", async () => {
    const lines = Array.from({ length: 30_000 }, (_, i) => `2026-11-05T${String(23 - Math.floor(i / 1300)).padStart(2, "0")}:00:00.${String(i).padStart(9, "0")}Z,GHSA-${i}`);
    const file = `${lines.join("\n")}\n`;
    const ranges: string[] = [];
    const fake = (async (_url: string, init?: RequestInit) => {
      const range = (init?.headers as Record<string, string>).range!;
      ranges.push(range);
      const [from, to] = range.replace("bytes=", "").split("-").map(Number) as [number, number];
      if (from >= file.length) return new Response("", { status: 416 });
      return new Response(file.slice(from, to + 1), { status: 206, headers: { "content-range": `bytes ${from}-${Math.min(to, file.length - 1)}/${file.length}` } });
    }) as unknown as typeof fetch;
    const catalog = createOsvCatalog({ fetch: fake });
    // 23:00 down to 06:00 inclusive: 18 hours of 1300 lines.
    const { changes, complete } = await catalog.changedSince("npm", Date.UTC(2026, 10, 5, 6), undefined);
    expect(complete).toBe(true);
    expect(changes.length).toBe(18 * 1300);
    expect(changes[0]!.id).toBe("GHSA-0");
    expect(new Set(changes.map((c) => c.id)).size).toBe(changes.length);
    expect(ranges.length).toBeGreaterThan(1);
  });

  test("a feed served whole (no range support) is read once", async () => {
    const fake = (async () => new Response("2026-11-05T10:00:00Z,A\n2026-11-04T10:00:00Z,B\n", { status: 200 })) as unknown as typeof fetch;
    const { changes } = await createOsvCatalog({ fetch: fake }).changedSince("PyPI", Date.UTC(2026, 10, 5), undefined);
    expect(changes.map((c) => c.id)).toEqual(["A"]);
  });

  test("matches follow a package's result pages", async () => {
    const calls: string[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push(new URL(url).pathname);
      const body = JSON.parse(String(init?.body));
      if (url.endsWith("/querybatch")) {
        return Response.json({ results: [{ vulns: [{ id: "A", modified: "m" }], next_page_token: "t1" }, {}] });
      }
      expect(body.page_token).toBe("t1");
      return Response.json({ vulns: [{ id: "B", modified: "m" }] });
    }) as unknown as typeof fetch;
    const result = await createOsvCatalog({ fetch: fake }).matches([
      { ecosystem: "npm", name: "a", version: "1.0.0" },
      { ecosystem: "npm", name: "b", version: "1.0.0" },
    ]);
    expect(result).toEqual([[{ id: "A", modified: "m" }, { id: "B", modified: "m" }], []]);
    expect(calls).toEqual(["/v1/querybatch", "/v1/query"]);
  });

  test("a git submodule is asked about by the commit it pins", async () => {
    let queries: unknown;
    const fake = (async (_url: string, init?: RequestInit) => {
      queries = JSON.parse(String(init?.body)).queries;
      return Response.json({ results: [{}, {}] });
    }) as unknown as typeof fetch;
    await createOsvCatalog({ fetch: fake }).matches([
      { ecosystem: "GIT", name: "https://github.com/acme/lib", version: "6879efc2c1596d11a6a6ad296f80063b558d5e0f" },
      { ecosystem: "npm", name: "a", version: "1.0.0" },
    ]);
    expect(queries).toEqual([{ commit: "6879efc2c1596d11a6a6ad296f80063b558d5e0f" }, { package: { ecosystem: "npm", name: "a" }, version: "1.0.0" }]);
  });

  test("a short batch answer is an error, not a silent gap", async () => {
    const fake = (async () => Response.json({ results: [] })) as unknown as typeof fetch;
    await expect(createOsvCatalog({ fetch: fake }).matches([{ ecosystem: "npm", name: "a", version: "1" }])).rejects.toThrow("answered 0 of 1");
  });

  test("records come from the bucket, then the API; a missing one is undefined", async () => {
    const seen: string[] = [];
    const fake = (async (url: string) => {
      seen.push(url);
      if (url.includes("storage.googleapis.com")) return new Response("", { status: 404 });
      if (url.endsWith("/GONE")) return new Response("", { status: 404 });
      return Response.json({ id: "X", modified: "m" });
    }) as unknown as typeof fetch;
    const catalog = createOsvCatalog({ fetch: fake });
    expect((await catalog.record("X", "npm"))?.id).toBe("X");
    expect(await catalog.record("GONE")).toBeUndefined();
    expect(seen[0]).toContain("/npm/X.json");
  });
});

describe("affectedNames", () => {
  const record: OsvRecord = {
    id: "CVE-1",
    modified: "m",
    affected: [{ package: { ecosystem: "npm", name: "a" } }, { ranges: [{ type: "GIT", repo: "https://github.com/Acme/Lib.git", events: [] }] }],
  };

  test("names packages, or for GIT the repositories of its commit ranges, keyed the way submodules are", () => {
    expect(affectedNames(record, "npm")).toEqual(["a"]);
    expect(affectedNames(record, "GIT").map((name) => packageKey("GIT", name))).toEqual([packageKey("GIT", "https://github.com/acme/lib")]);
  });
});

describe("toInventory", () => {
  const dep = (over: Partial<Dependency>): Dependency => ({ ecosystem: "npm", name: "next", version: "15.5.3", manifest: "bun.lock", direct: true, dev: false, reachability: "imported", importedAt: ["apps/web/app/page.tsx:1"], ...over });

  test("classifies how close each package is to shipped code", () => {
    const inventory = toInventory([
      dep({}),
      dep({ name: "vitest", importedAt: ["apps/web/vitest.config.ts:1", "src/a.test.ts:2"] }),
      dep({ name: "react", reachability: "not_imported", importedAt: [] }),
      dep({ ecosystem: "crates.io", name: "serde", reachability: "unknown", importedAt: [] }),
    ]);
    expect(inventory.map((e) => [e.name, e.usage])).toEqual([
      ["next", "product"],
      ["vitest", "tooling"],
      ["react", "none"],
      ["serde", "unknown"],
    ]);
  });

  test("puts shipped import sites first", () => {
    const [entry] = toInventory([dep({ importedAt: ["apps/web/next.config.mjs:1", "apps/web/app/layout.tsx:3"] })]);
    expect(entry!.importedAt).toEqual(["apps/web/app/layout.tsx:3", "apps/web/next.config.mjs:1"]);
  });

  test("a lockfile version beats a range's floor for the same package; a lone range is kept, marked approximate", () => {
    const inventory = toInventory([dep({ version: "15.0.0", manifest: "apps/web/package.json", approximate: true }), dep({}), dep({ name: "express", version: "4.17.1", manifest: "package.json", approximate: true })]);
    expect(inventory.map((e) => `${e.name}@${e.version}${e.approximate ? "~" : ""}`)).toEqual(["next@15.5.3", "express@4.17.1~"]);
  });

  test("skips entries without a version and duplicates", () => {
    expect(toInventory([dep({ version: "" }), dep({}), dep({ manifest: "apps/x/bun.lock" })])).toHaveLength(1);
  });
});
