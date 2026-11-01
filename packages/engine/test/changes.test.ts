import { describe, expect, test } from "bun:test";
import { capChanges, isSecurityRelevant, touchesChange, type ChangedFile } from "../src/scan/changes";
import { excerptLine, reanchor } from "../src/scan/fixcheck";
import type { Finding } from "../src/scan/schema";

describe("security-relevant changes", () => {
  test("skips lockfiles, generated, vendored, docs, assets and tests", () => {
    const skip = ["package-lock.json", "web/yarn.lock", "dist/app.js", "app.min.js", "docs/setup.md", "README.md", "logo.png", "src/a.test.ts", "tests/api.py", "pkg/x_test.go", "node_modules/x/index.js"];
    const keep = ["src/routes/login.ts", "app/api/users/route.ts", "server.go", "views.py", "Dockerfile", "config/settings.py"];
    expect(skip.filter(isSecurityRelevant)).toEqual([]);
    expect(keep.filter(isSecurityRelevant)).toEqual(keep);
  });

  const file = (path: string, lines: number): ChangedFile => ({ path, status: "modified", additions: lines, deletions: 0, hunks: [[10, 10 + lines]] });

  test("caps large changes, riskiest files first", () => {
    const risk = (path: string) => (path === "auth.ts" ? 5 : path === "db.ts" ? 2 : 0);
    const { kept, dropped } = capChanges([file("ui.ts", 3_000), file("auth.ts", 2_000), file("db.ts", 2_500)], 5_000, risk);
    expect(kept.map((f) => f.path)).toEqual(["auth.ts", "db.ts"]);
    expect(dropped.map((f) => f.path)).toEqual(["ui.ts"]);
  });

  test("always reviews at least one file, however large", () => {
    expect(capChanges([file("huge.ts", 9_000)], 5_000, () => 0).kept).toHaveLength(1);
  });

  test("a finding touches the change when a citation is in or next to a hunk", () => {
    const files = [file("auth.ts", 5)];
    expect(touchesChange(files, [{ file: "auth.ts", line: 12 }])).toBe(true);
    expect(touchesChange(files, [{ file: "auth.ts", line: 18 }])).toBe(true);
    expect(touchesChange(files, [{ file: "auth.ts", line: 40 }, { file: "other.ts", line: 12 }])).toBe(false);
  });
});

describe("fix-check re-anchoring", () => {
  const finding = {
    entryPoint: { file: "routes.ts", line: 4, description: "POST /login" },
    attackPath: [
      { file: "login.ts", line: 10, note: "reads email", excerpt: [" 9| x", "10| const email = req.body.email;", "11| y"].join("\n") },
      { file: "login.ts", line: 20, note: "sink", excerpt: ["19| a", '20| db.query("..." + email);', "21| b"].join("\n") },
    ],
  } as unknown as Finding;

  test("reads the cited line from an excerpt", () => {
    expect(excerptLine([" 9| x", "10| const email = req.body.email;"].join("\n"), 10)).toBe("const email = req.body.email;");
    expect(excerptLine("9| x", 10)).toBeUndefined();
  });

  test("follows code that moved", async () => {
    const lines = new Map([
      ["routes.ts", ["", "", "", "router.post(login)"]],
      ["login.ts", [...Array(14).fill("pad"), "  const email = req.body.email;", ...Array(10).fill("pad"), '  db.query("..." + email);']],
    ]);
    const moved = await reanchor(finding, async (path) => lines.get(path));
    expect(moved!.attackPath.map((s) => s.line)).toEqual([15, 26]);
    expect(moved!.entryPoint.line).toBe(4);
  });

  test("follows a sink line that the fix rewrote", async () => {
    const lines = new Map([["routes.ts", ["router.post(login)"]], ["login.ts", ["  const email = req.body.email;", 'db.query("... = $1", [email]);']]]);
    const moved = await reanchor(finding, async (path) => lines.get(path));
    expect(moved!.attackPath.at(-1)!.line).toBe(2);
  });

  test("is stale when the sink's code is gone", async () => {
    const lines = new Map([["routes.ts", ["router.post(login)"]], ["login.ts", ["  const email = req.body.email;", "return null;"]]]);
    expect(await reanchor(finding, async (path) => lines.get(path))).toBeUndefined();
  });
});
