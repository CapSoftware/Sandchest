/** The scan page's step track, from a scan's status and the stages its feed reached. */
import { describe, expect, test } from "bun:test";
import { RECON_WAIT, stepOf, trackOf, TRACKS, trackStates } from "@/lib/scan-progress";

const deep = TRACKS.deep!.map((step) => step.key);

describe("scan track", () => {
  test("lists each kind's steps in the order the engine runs them", () => {
    expect(deep).toEqual(["setup", "index", "sweep", "recon", "hunt", "verify", "report"]);
    expect(TRACKS.pr_review!.map((s) => s.key)).toEqual(["setup", "index", "sweep", "hunt", "verify", "report"]);
    expect(TRACKS.recon!.map((s) => s.key)).toEqual(["setup", "index", "recon", "report"]);
  });

  test("maps feed lines to steps: coverage is more hunting, done is reporting, plain lines mark nothing", () => {
    expect(["stage:setup", "stage:coverage", "stage:done", "stage:verify", "finding", "warning", "queue", "stage"].map(stepOf)).toEqual([
      "setup",
      "hunt",
      "report",
      "verify",
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  test("a waiting scan has no current step", () => {
    expect(trackStates("deep", "queued", ["queue"])).toEqual(deep.map(() => "pending"));
  });

  test("a running scan lights the furthest step reached, and setup before any", () => {
    expect(trackStates("deep", "running", [])).toEqual(["current", "pending", "pending", "pending", "pending", "pending", "pending"]);
    expect(trackStates("deep", "running", ["stage:setup", "stage:index", "stage:sweep", "stage:recon", "finding", "stage:hunt", "stage:coverage"])).toEqual([
      "done",
      "done",
      "done",
      "done",
      "current",
      "pending",
      "pending",
    ]);
    // Publishing is the report step, whatever the feed last said.
    expect(trackStates("pr_review", "publishing", ["stage:verify"]).at(-1)).toBe("current");
  });

  test("finished scans are all done; failed ones mark where they stopped", () => {
    expect(trackStates("recon", "completed", [])).toEqual(["done", "done", "done", "done"]);
    expect(trackStates("deep", "failed", ["stage:setup", "stage:index", "stage:sweep"])).toEqual(["done", "done", "failed", "pending", "pending", "pending", "pending"]);
    expect(trackStates("deep", "refused", [])).toEqual(deep.map(() => "pending"));
  });

  test("a deep scan that waits for its repository's recon shows recon as its first step, then moves past it", () => {
    expect(trackOf("deep", [RECON_WAIT]).map((s) => s.key)).toEqual(["wait", ...deep]);
    expect(trackOf("deep", ["queue"])).toBe(TRACKS.deep!);
    expect(trackStates("deep", "queued", [RECON_WAIT])).toEqual(["current", ...deep.map(() => "pending" as const)]);
    // Started, before its first stage line arrives: setup is current, recon done.
    expect(trackStates("deep", "running", [RECON_WAIT])).toEqual(["done", "current", ...deep.slice(1).map(() => "pending" as const)]);
    expect(trackStates("deep", "running", [RECON_WAIT, "stage:setup", "stage:index"])).toEqual(["done", "done", "current", ...deep.slice(2).map(() => "pending" as const)]);
    expect(trackStates("deep", "completed", [RECON_WAIT])).toHaveLength(deep.length + 1);
  });
});
