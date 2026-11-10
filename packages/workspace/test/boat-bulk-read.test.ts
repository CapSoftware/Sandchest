/**
 * The bulk read against a real Boat sandbox, which bills. Skipped unless a key is present:
 *
 *   bun --env-file=../../.env.local test test/boat-bulk-read.test.ts   # reads SANDCHEST_BOAT_API_KEY
 *
 * One sandbox: a synthetic checkout of a few thousand files is made inside it (no network), read in
 * bulk, and a sample is compared with single reads.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BoatWorkspace, bulkReadFiles } from "../src/boat";

const apiKey = process.env.SANDCHEST_BOAT_API_KEY ?? "";
const TIMEOUT = 600_000;

/** Writes the checkout in the current directory: 3,000 handlers of 1 to 12 KB, odd names and odd content, then commits it. */
const GENERATE = `"use strict";
const fs = require("fs");
let seed = 7;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const line = (i) => "  const v" + i + " = req.params.id + " + Math.floor(rand() * 1e6) + "; // " + "x".repeat(Math.floor(rand() * 60)) + "\\n";
for (let m = 0; m < 60; m++) {
  fs.mkdirSync("src/api/mod" + m, { recursive: true });
  for (let h = 0; h < 50; h++) {
    let text = (h % 10 === 0 ? '"use server";\\n' : "") + "export async function handler" + h + "(req) {\\n";
    const lines = 10 + Math.floor(rand() * 120);
    for (let i = 0; i < lines; i++) text += line(i);
    fs.writeFileSync("src/api/mod" + m + "/handler" + h + (h % 10 === 0 ? ".tsx" : ".ts"), text + "}\\n");
  }
}
fs.mkdirSync("src/odd", { recursive: true });
for (const name of ["it's.ts", 'double "q".ts', "new\\nline.ts", "-dash.ts", "$(touch pwned).ts", "sp ace.ts", "ünï.ts"]) fs.writeFileSync("src/odd/" + name, "// " + name + "\\n");
fs.writeFileSync("src/odd/bom.ts", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("export const a = 1;\\n")]));
fs.writeFileSync("src/odd/invalid.ts", Buffer.concat([Buffer.from("const a = '"), Buffer.from([0xff, 0xfe, 0xc3, 0x28, 0xe2, 0x82]), Buffer.from("';\\n")]));
fs.writeFileSync("src/odd/huge.ts", "y".repeat(2 * 1024 * 1024));
fs.symlinkSync("/etc/passwd", "src/odd/link.ts");
`;

describe.skipIf(!apiKey)("bulkReadFiles on Boat", () => {
  let workspace: BoatWorkspace;

  beforeAll(async () => {
    const started = performance.now();
    workspace = await BoatWorkspace.create({ apiKey, type: "small", ttlSeconds: 15 * 60, labels: { purpose: "workspace-test" } });
    console.log(`create + ready: ${Math.round(performance.now() - started)}ms`);
  }, TIMEOUT);

  afterAll(async () => {
    if (!workspace) return;
    try {
      await workspace.destroy();
    } finally {
      const gone = await BoatWorkspace.attach(workspace.id, { apiKey }).then(
        (attached) => attached.destroy().then(() => false),
        () => true,
      );
      console.log(`sandbox gone after delete: ${gone}`);
    }
  }, TIMEOUT);

  test(
    "reads a synthetic checkout in bulk, identically to single reads",
    async () => {
      await workspace.writeFiles([{ path: `${workspace.root}/README.md`, content: "synthetic\n" }]);
      const generated = await workspace.exec(["node", "-e", GENERATE], { timeoutMs: 300_000 });
      expect(generated.stderr).toBe("");
      const git = ["-c", "user.name=test", "-c", "user.email=test@example.com"];
      const committed = await workspace.exec(["sh", "-c", 'git init -q && git add -A && git "$@" commit -qm synthetic', "sh", ...git], { timeoutMs: 300_000 });
      expect(committed.exitCode).toBe(0);
      const listed = await workspace.exec(["git", "ls-files", "-z"]);
      const files = listed.stdout.split("\0").filter(Boolean);
      expect(files.length).toBeGreaterThan(3_000);

      let started = performance.now();
      const read = await bulkReadFiles(workspace, files);
      const bulkMs = performance.now() - started;
      const textBytes = [...read.files.values()].reduce((n, t) => n + (t === undefined ? 0 : Buffer.byteLength(t)), 0);
      console.log(`bulk: ${files.length} files, ${read.files.size} records, ${read.parts} parts, ${read.bytes} bytes packed (${textBytes} as text), ${Math.round(bulkMs)}ms`);
      expect(read.files.size).toBe(files.length);
      expect(read.parts).toBeGreaterThan(1);
      expect(read.files.get("src/odd/link.ts")).toBeUndefined();
      expect(read.files.get("src/odd/huge.ts")).toBeUndefined();
      // No name ran as a command: nothing called `pwned` was made anywhere.
      expect((await workspace.exec(["sh", "-c", "find / -xdev -name pwned 2>/dev/null | wc -l"])).stdout.trim()).toBe("0");
      expect((await workspace.exec(["sh", "-c", `ls -A ${workspace.privateFilesDir} | grep -c '^bulk-' || true`])).stdout.trim()).toBe("0");

      // A hundred single reads, as the hunt made them one after another: the odd files and a spread of the rest.
      const odd = files.filter((f) => f.startsWith("src/odd/") && !f.endsWith("link.ts") && !f.endsWith("huge.ts"));
      const rest = files.filter((f) => !f.startsWith("src/odd/"));
      const sample = [...odd, ...Array.from({ length: 100 - odd.length }, (_, i) => rest[Math.floor((i * rest.length) / (100 - odd.length))]!)];
      started = performance.now();
      const single: string[] = [];
      for (const file of sample) single.push(await workspace.readFile(file));
      const singleMs = performance.now() - started;
      console.log(`single: ${sample.length} reads, ${Math.round(singleMs)}ms (${Math.round(singleMs / sample.length)}ms each; ${files.length} would take about ${Math.round(((singleMs / sample.length) * files.length) / 1000)}s)`);
      sample.forEach((file, i) => expect(read.files.get(file)).toBe(single[i]!));
      expect(read.files.get("src/odd/bom.ts")!.charCodeAt(0)).toBe(0xfeff);
      expect(read.files.get("src/odd/invalid.ts")).toContain("�");
    },
    TIMEOUT,
  );
});
