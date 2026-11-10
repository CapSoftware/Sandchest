/** The bulk read's packer, run locally on a temporary checkout, and its unpacker. No network, no real sandbox. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecOptions, ExecResult } from "../src";
import { BULK_READ_LIMITS, BulkUnpacker, bulkReadFiles, type BulkReadLimits, type BulkReadSandbox } from "../src/bulk-read";

let base: string;
let checkout: string;

/** The sandbox runs the packer with node; this runtime stands in where there is none. */
const NODE = Bun.which("node") ?? process.execPath;

/** A sandbox on this machine: commands run in the checkout. */
class LocalSandbox implements BulkReadSandbox {
  readonly privateFilesDir: string;
  readonly commands: string[][] = [];
  partReads = 0;

  constructor() {
    this.privateFilesDir = mkdtempSync(join(base, "private-"));
    chmodSync(this.privateFilesDir, 0o700);
  }

  async exec(cmd: string[], options: ExecOptions = {}): Promise<ExecResult> {
    this.commands.push(cmd);
    const argv = cmd[0] === "node" ? [NODE, ...cmd.slice(1)] : cmd;
    const started = performance.now();
    const proc = Bun.spawnSync(argv, { cwd: checkout, timeout: options.timeoutMs });
    return { exitCode: proc.exitCode ?? 1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString(), timedOut: false, durationMs: performance.now() - started };
  }

  async writePrivateFiles(files: Array<{ name: string; content: string }>): Promise<void> {
    for (const file of files) writeFileSync(join(this.privateFilesDir, file.name), file.content, { mode: 0o600 });
  }

  async readPrivateBytes(name: string): Promise<Buffer | undefined> {
    this.partReads++;
    try {
      return readFileSync(join(this.privateFilesDir, name));
    } catch {
      return undefined;
    }
  }
}

const HOSTILE = [
  "it's a file.ts",
  'double "quoted".ts',
  "new\nline.ts",
  "-leading-dash.ts",
  "--help",
  "$(touch pwned).ts",
  "back\\slash.ts",
  "tab\there.ts",
  "ünïcödé/日本.ts",
  " spaced .ts",
];

/** Bytes that are not valid UTF-8, a byte-order mark, a NUL and every byte value. */
const BINARY = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("const a = 1;\n"), Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28]), Buffer.from(Array.from({ length: 256 }, (_, i) => i))]);

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "bulk-read-"));
  checkout = join(base, "repo");
  mkdirSync(join(checkout, "src/api"), { recursive: true });
  mkdirSync(join(checkout, "ünïcödé"), { recursive: true });
  for (const name of HOSTILE) writeFileSync(join(checkout, name), `// ${name}\nexport const x = 1;\n`);
  writeFileSync(join(checkout, "src/api/binary.ts"), BINARY);
  writeFileSync(join(checkout, "src/api/empty.ts"), "");
  writeFileSync(join(checkout, "src/api/big.ts"), "x".repeat(2_000));
  for (let i = 0; i < 20; i++) writeFileSync(join(checkout, `src/api/h${i}.ts`), `export function h${i}(req) {\n  return req.params.id + ${i};\n}\n`.repeat(i + 1));
  writeFileSync(join(base, "outside.ts"), "secret outside the checkout\n");
  symlinkSync(join(base, "outside.ts"), join(checkout, "src/api/escape.ts"));
  symlinkSync("h1.ts", join(checkout, "src/api/inside-link.ts"));
  symlinkSync(join(checkout, "src/api"), join(checkout, "linked-dir"));
  mkdirSync(join(checkout, "src/api/folder.ts"));
});

afterAll(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

const limits = (extra: Partial<BulkReadLimits>): BulkReadLimits => ({ ...BULK_READ_LIMITS, ...extra });
const plain = (file: string) => readFileSync(join(checkout, file)).toString("utf8");

describe("bulkReadFiles", () => {
  test("round-trips hostile names and binary content, split into parts mid-file", async () => {
    const files = [...HOSTILE, "src/api/binary.ts", "src/api/empty.ts", ...Array.from({ length: 20 }, (_, i) => `src/api/h${i}.ts`)];
    const sandbox = new LocalSandbox();
    // 37-byte parts: every header and most files straddle a boundary.
    const read = await bulkReadFiles(sandbox, files, limits({ partBytes: 37, concurrency: 3 }));
    expect(read.parts).toBeGreaterThan(50);
    expect(read.files.size).toBe(files.length);
    for (const file of files) expect(read.files.get(file)).toBe(plain(file));
    expect(read.files.get("src/api/binary.ts")).toBe(BINARY.toString("utf8"));
    expect(read.files.get("src/api/binary.ts")!.charCodeAt(0)).toBe(0xfeff);
    expect(read.files.get("src/api/empty.ts")).toBe("");
    // No name was ever on a command line, and nothing ran from one.
    for (const cmd of sandbox.commands) for (const name of HOSTILE) expect(cmd.join(" ")).not.toContain(name);
    expect(readdirSync(checkout)).not.toContain("pwned");
    expect(readdirSync(sandbox.privateFilesDir)).toEqual([]);
  });

  test("the same files read the same in one part or many", async () => {
    const files = Array.from({ length: 20 }, (_, i) => `src/api/h${i}.ts`);
    const one = await bulkReadFiles(new LocalSandbox(), files);
    const many = await bulkReadFiles(new LocalSandbox(), files, limits({ partBytes: 100 }));
    expect(one.parts).toBe(1);
    expect(many.parts).toBeGreaterThan(1);
    expect([...many.files]).toEqual([...one.files]);
    expect(many.bytes).toBe(one.bytes);
  });

  test("symlinks, folders, missing files and paths out of the checkout read as absent", async () => {
    const files = ["src/api/escape.ts", "src/api/inside-link.ts", "linked-dir/h1.ts", "src/api/folder.ts", "src/api/missing.ts", "../outside.ts", "/etc/hosts", "src/api/h1.ts"];
    const read = await bulkReadFiles(new LocalSandbox(), files);
    expect([...read.files]).toEqual([...files.slice(0, -1).map((f): [string, string | undefined] => [f, undefined]), ["src/api/h1.ts", plain("src/api/h1.ts")]]);
  });

  test("a file over the size limit reads as absent; past the total limit files are left out", async () => {
    const sizes = await bulkReadFiles(new LocalSandbox(), ["src/api/big.ts", "src/api/h0.ts"], limits({ maxFileBytes: 1_999 }));
    expect([...sizes.files]).toEqual([["src/api/big.ts", undefined], ["src/api/h0.ts", plain("src/api/h0.ts")]]);
    expect((await bulkReadFiles(new LocalSandbox(), ["src/api/big.ts"], limits({ maxFileBytes: 2_000 }))).files.get("src/api/big.ts")).toBe("x".repeat(2_000));

    const files = Array.from({ length: 20 }, (_, i) => `src/api/h${i}.ts`);
    const total = 4 + 9 * 3 + files.slice(0, 3).reduce((n, f) => n + Buffer.byteLength(plain(f)), 0);
    const capped = await bulkReadFiles(new LocalSandbox(), files, limits({ maxTotalBytes: total }));
    expect([...capped.files.keys()]).toEqual(files.slice(0, 3));
    expect(capped.bytes).toBe(total);
    const under = await bulkReadFiles(new LocalSandbox(), files, limits({ maxTotalBytes: total - 1 }));
    expect([...under.files.keys()]).toEqual(files.slice(0, 2));
  });

  test("a failed pack, a missing part or no list at all", async () => {
    expect((await bulkReadFiles(new LocalSandbox(), [])).files.size).toBe(0);
    const failing = new LocalSandbox();
    failing.exec = async (cmd) => ({ exitCode: cmd[0] === "node" ? 1 : 0, stdout: "", stderr: "", timedOut: false, durationMs: 1 });
    await expect(bulkReadFiles(failing, ["src/api/h0.ts"])).rejects.toThrow("Packing the checkout failed");
    const lossy = new LocalSandbox();
    lossy.readPrivateBytes = async () => undefined;
    await expect(bulkReadFiles(lossy, ["src/api/h0.ts"])).rejects.toThrow("part 0 is missing");
    // The list and the parts are removed even then.
    expect(readdirSync(lossy.privateFilesDir)).toEqual([]);
  });
});

describe("BulkUnpacker", () => {
  const record = (kind: number, index: number, body = Buffer.alloc(0)) => {
    const h = Buffer.alloc(9);
    h[0] = kind;
    h.writeUInt32BE(index, 1);
    h.writeUInt32BE(body.length, 5);
    return Buffer.concat([h, body]);
  };
  const stream = Buffer.concat([Buffer.from("SCB1"), record(1, 0, Buffer.from("héllo")), record(0, 1), record(1, 2, Buffer.from("")), record(2, 3)]);

  test("decodes byte by byte as in one piece", () => {
    const whole = new BulkUnpacker(["a", "b", "c"]);
    whole.push(stream);
    const bytes = new BulkUnpacker(["a", "b", "c"]);
    for (const b of stream) bytes.push(Uint8Array.of(b));
    expect([...bytes.finish()]).toEqual([...whole.finish()]);
    expect([...whole.finish()]).toEqual([["a", "héllo"], ["b", undefined], ["c", ""]]);
  });

  test("refuses a corrupt or cut stream", () => {
    const corrupt = (bytes: Buffer, files = ["a", "b", "c"]) => () => {
      const u = new BulkUnpacker(files, 10);
      u.push(bytes);
      u.finish();
    };
    expect(corrupt(Buffer.from("XXXX"))).toThrow("not a packed stream");
    expect(corrupt(stream.subarray(0, stream.length - 1))).toThrow("ends early");
    expect(corrupt(Buffer.concat([stream, Buffer.from("x")]))).toThrow("bad end");
    expect(corrupt(Buffer.concat([Buffer.from("SCB1"), record(1, 5, Buffer.from("x")), record(2, 1)]))).toThrow("bad record");
    expect(corrupt(Buffer.concat([Buffer.from("SCB1"), record(1, 1), record(1, 0), record(2, 2)]))).toThrow("bad record");
    expect(corrupt(Buffer.concat([Buffer.from("SCB1"), record(1, 0, Buffer.alloc(11)), record(2, 1)]))).toThrow("bad record");
    expect(corrupt(Buffer.concat([Buffer.from("SCB1"), record(2, 2)]))).toThrow("bad end");
  });
});
