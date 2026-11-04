/**
 * The demo at /demo: its links stay inside it, and its made-up account holds together, so every link a demo page
 * draws leads to a demo page that exists.
 */
import { describe, expect, test } from "bun:test";
import { inDemo } from "@/components/app/demo";
import { DEMO_LIVE_SCAN_ID, demoFinding, demoFindingCounts, demoFindings, demoRepo, demoRepos, demoScan, demoScans, LIVE_ENDS_AT, LIVE_SCRIPT } from "@/lib/demo";
import { isUuid } from "@/lib/uuid";

describe("inDemo", () => {
  test("moves dashboard paths under the demo, keeping the rest of the path, query and hash", () => {
    expect(inDemo("/dashboard", "/demo")).toBe("/demo");
    expect(inDemo("/dashboard/findings?severity=high", "/demo")).toBe("/demo/findings?severity=high");
    expect(inDemo("/dashboard?later=1", "/demo")).toBe("/demo?later=1");
    expect(inDemo("/dashboard#billing", "/demo")).toBe("/demo#billing");
    expect(inDemo("/dashboard/settings#billing", "/demo")).toBe("/demo/settings#billing");
  });

  test("leaves every other link alone", () => {
    for (const href of ["/", "/docs", "/dashboards", "https://github.com/acme/api", "/demo/scans"]) expect(inDemo(href, "/demo")).toBe(href);
  });
});

describe("the made-up account", () => {
  test("every id is a UUID, as the pages require", () => {
    const ids = [...demoRepos().map((r) => r.id), ...demoScans().map((s) => s.id), ...(["open", "fixed", "dismissed"] as const).flatMap((status) => demoFindings({ status }).map((f) => f.id))];
    for (const id of ids) expect(isUuid(id)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every listed scan, finding and repository opens", () => {
    for (const scan of demoScans()) expect(demoScan(scan.id)?.scan.id).toBe(scan.id);
    for (const status of ["open", "fixed", "dismissed"] as const) for (const finding of demoFindings({ status })) expect(demoFinding(finding.id)?.finding.id).toBe(finding.id);
    for (const repo of demoRepos()) expect(demoRepo(repo.id)?.fullName).toBe(repo.fullName);
  });

  test("a finding's scan reported it, and its repository is the scan's", () => {
    for (const status of ["open", "fixed", "dismissed"] as const)
      for (const item of demoFindings({ status })) {
        const row = demoFinding(item.id)!;
        const scan = demoScan(row.finding.sourceScanId!)!;
        expect(scan.repo.id).toBe(row.repo.id);
        expect(row.repo.id).toBe(item.repoId);
      }
  });

  test("open counts on the repositories match the findings list", () => {
    for (const repo of demoRepos()) {
      const open = demoFindings({ repoId: repo.id });
      expect(Object.values(repo.open).reduce((a, b) => a + b, 0)).toBe(open.length);
    }
    expect(demoFindingCounts({}).open).toBe(demoFindings().length);
  });

  test("the live scan's feed names each finding it shows, in order, before it ends", () => {
    const live = demoScan(DEMO_LIVE_SCAN_ID)!;
    expect(live.scan.status).toBe("running");
    const named = LIVE_SCRIPT.filter(([, type]) => type === "finding").map(([, , message]) => message);
    expect(named).toEqual(live.findings.map((f) => f.title));
    expect(Math.max(...LIVE_SCRIPT.map(([at]) => at))).toBeLessThan(LIVE_ENDS_AT);
    const times = LIVE_SCRIPT.map(([at]) => at);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});
