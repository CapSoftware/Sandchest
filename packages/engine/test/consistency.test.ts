import { describe, expect, test } from "bun:test";
import { detectAuthzDeviations, type HandlerGuards } from "../src/scan/consistency";

const h = (name: string, dir: string, guards: string[]): HandlerGuards => ({ name, at: `${dir}/${name}.ts:10`, guards });

describe("detectAuthzDeviations", () => {
  test("flags the handler missing the guard its peers share", () => {
    const group = [
      h("addVideos", "actions/folders", ["getSpaceAccess"]),
      h("moveItems", "actions/folders", ["getSpaceAccess"]),
      h("removeVideos", "actions/folders", []), // the deviant
    ];
    const d = detectAuthzDeviations(group);
    expect(d.map((x) => x.name)).toEqual(["removeVideos"]);
    expect(d[0]!.expected).toContain("getSpaceAccess");
  });

  test("no deviation when the group is consistent", () => {
    const group = [
      h("a", "d", ["getSpaceAccess"]),
      h("b", "d", ["getSpaceAccess"]),
      h("c", "d", ["getSpaceAccess"]),
    ];
    expect(detectAuthzDeviations(group)).toHaveLength(0);
  });

  test("ignores groups smaller than the minimum (no majority to deviate from)", () => {
    expect(detectAuthzDeviations([h("a", "d", ["x"]), h("b", "d", [])])).toHaveLength(0);
  });

  test("a guard is only expected when a majority of the group applies it", () => {
    // getSpaceAccess is used by only 1 of 4 → not expected; getCurrentUser by 3/4 → expected.
    const group = [
      h("a", "d", ["getSpaceAccess"]),
      h("b", "d", ["getCurrentUser"]),
      h("c", "d", ["getCurrentUser"]),
      h("d", "d", ["getCurrentUser"]),
    ];
    // "a" applies one guard (a different one), not fewer than expected — deliberately NOT flagged,
    // so a handler that guards differently but equivalently is not noise. Only clearly
    // under-guarded handlers are flagged.
    expect(detectAuthzDeviations(group)).toHaveLength(0);
  });

  test("flags a handler with fewer guards than its peers' expected set", () => {
    const group = [
      h("a", "d", ["getCurrentUser", "getSpaceAccess"]),
      h("b", "d", ["getCurrentUser", "getSpaceAccess"]),
      h("c", "d", ["getCurrentUser"]), // has one of the two expected guards → under-guarded → deviant
    ];
    expect(detectAuthzDeviations(group).map((x) => x.name)).toEqual(["c"]);
  });

  test("different directories are separate families", () => {
    const group = [
      h("a", "x", ["guardA"]),
      h("b", "x", ["guardA"]),
      h("c", "x", ["guardA"]),
      h("lonely", "y", []), // different dir, its own (too-small) group
    ];
    expect(detectAuthzDeviations(group).map((x) => x.name)).toEqual([]);
  });
});

import { authzScoreLeads, detectAuthzScoreDeviations, type ScoredHandler } from "../src/scan/consistency";

const sh = (name: string, dir: string, authz: number): ScoredHandler => ({ name, at: `${dir}/${name}.py:10`, authz });

describe("detectAuthzScoreDeviations", () => {
  test("flags the low-authz handler whose peers enforce authorization", () => {
    const group = [sh("a", "handlers", 0.9), sh("b", "handlers", 0.85), sh("leak", "handlers", 0.2)];
    const d = detectAuthzScoreDeviations(group);
    expect(d.map((x) => x.name)).toEqual(["leak"]);
  });

  test("no deviation when the whole group is low (no policy to deviate from)", () => {
    const group = [sh("a", "h", 0.2), sh("b", "h", 0.25), sh("c", "h", 0.3)];
    expect(detectAuthzScoreDeviations(group)).toHaveLength(0);
  });

  test("no deviation when the whole group enforces", () => {
    const group = [sh("a", "h", 0.9), sh("b", "h", 0.8), sh("c", "h", 0.95)];
    expect(detectAuthzScoreDeviations(group)).toHaveLength(0);
  });

  test("ignores groups below the minimum", () => {
    expect(detectAuthzScoreDeviations([sh("a", "h", 0.9), sh("leak", "h", 0.1)])).toHaveLength(0);
  });

  test("emits a missing_check lead with the handler location", () => {
    const leads = authzScoreLeads([sh("a", "h", 0.9), sh("b", "h", 0.9), sh("leak", "h", 0.1)], () => "MC1");
    expect(leads).toHaveLength(1);
    expect(leads[0]!.kind).toBe("missing_check");
    expect(leads[0]!.at).toBe("h/leak.py:10");
  });
});
