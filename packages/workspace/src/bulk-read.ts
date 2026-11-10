/**
 * Reads many checkout files from a sandbox in a few calls instead of one call per file. One command
 * packs the wanted files into a single stream in the sandbox user's private directory, cut into parts
 * under the host's read cap; the parts are fetched and unpacked in memory.
 *
 * The stream: the magic `SCB1`, then one record per file in list order, each a 9-byte header (kind:
 * u8, index into the list: u32 BE, length: u32 BE) and, for kind 1, that many bytes of content. Kind 0
 * is a file that was skipped (missing, not a regular file, a symlink, over the size limit, unreadable),
 * which reads as absent. Kind 2 ends the stream, its index the number of records before it. Files
 * past the total limit get no record, so the caller reads them one by one.
 */
import { randomBytes } from "node:crypto";
import { WorkspaceError, type ExecOptions, type ExecResult } from "./index";

export const BULK_READ_LIMITS = {
  /** Larger files are skipped and read as absent: no source file the hunt wants is this large. */
  maxFileBytes: 1024 * 1024,
  /** Packed bytes in all; the files past it are left to single reads. */
  maxTotalBytes: 256 * 1024 * 1024,
  /** Bytes per part, under the host's 5 MiB read cap. */
  partBytes: 4 * 1024 * 1024,
  /** Parts fetched at once. */
  concurrency: 6,
};

export type BulkReadLimits = typeof BULK_READ_LIMITS;

const MAGIC = "SCB1";
const HEADER = 9;
const PACK_TIMEOUT_MS = 5 * 60_000;

/**
 * The packer, run with `node -e` in the checkout: `-- <list> <part prefix> <part bytes> <max file>
 * <max total>`. The list is a JSON array of checkout-relative paths, read from a file so no path is
 * ever on a command line. A path that leaves the checkout, or passes through a symlink, is skipped.
 */
export const BULK_PACK_SCRIPT = `"use strict";
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(1);
const listFile = args[0], prefix = args[1], partBytes = Number(args[2]), maxFile = Number(args[3]), maxTotal = Number(args[4]);
if (!(partBytes > 0 && maxFile >= 0 && maxTotal > 0)) throw new Error("bad limits");
const root = fs.realpathSync(".");
const list = JSON.parse(fs.readFileSync(listFile, "utf8"));
let part = 0, inPart = 0;
let out = fs.openSync(prefix + part, "wx", 0o600);
function put(buf) {
  let at = 0;
  while (at < buf.length) {
    if (inPart === partBytes) {
      fs.closeSync(out);
      out = fs.openSync(prefix + ++part, "wx", 0o600);
      inPart = 0;
    }
    const n = fs.writeSync(out, buf, at, Math.min(buf.length - at, partBytes - inPart));
    at += n;
    inPart += n;
  }
}
function header(kind, index, length) {
  const h = Buffer.alloc(9);
  h[0] = kind;
  h.writeUInt32BE(index, 1);
  h.writeUInt32BE(length, 5);
  return h;
}
function contentOf(file) {
  if (typeof file !== "string" || file === "" || file.indexOf("\\0") >= 0) return null;
  const full = path.resolve(root, file);
  if (!full.startsWith(root + path.sep)) return null;
  let fd = -1;
  try {
    const stat = fs.lstatSync(full);
    if (!stat.isFile() || stat.size > maxFile) return null;
    if (fs.realpathSync(full) !== full) return null;
    fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const size = fs.fstatSync(fd).size;
    if (size > maxFile) return null;
    const buf = Buffer.alloc(size);
    let got = 0;
    while (got < size) {
      const n = fs.readSync(fd, buf, got, size - got, got);
      if (n === 0) break;
      got += n;
    }
    return buf.subarray(0, got);
  } catch (error) {
    return null;
  } finally {
    if (fd >= 0) fs.closeSync(fd);
  }
}
put(Buffer.from("${MAGIC}"));
let written = 4, records = 0;
for (let i = 0; i < list.length; i++) {
  const body = contentOf(list[i]);
  const size = 9 + (body ? body.length : 0);
  if (written + size > maxTotal) break;
  put(header(body ? 1 : 0, i, body ? body.length : 0));
  if (body) put(body);
  written += size;
  records++;
}
put(header(2, records, 0));
fs.closeSync(out);
process.stdout.write(JSON.stringify({ parts: part + 1, records: records, bytes: written }));
`;

/** What a bulk read needs from a sandbox. `BoatWorkspace` is one. */
export interface BulkReadSandbox {
  /** The mode-700 directory `writePrivateFiles` writes to. */
  readonly privateFilesDir: string;
  exec(cmd: string[], options?: ExecOptions): Promise<ExecResult>;
  writePrivateFiles(files: Array<{ name: string; content: string }>): Promise<void>;
  readPrivateBytes(name: string): Promise<Buffer | undefined>;
}

export interface BulkReadResult {
  /** Text per file packed; undefined for a skipped file. A file past the total limit has no entry. */
  files: Map<string, string | undefined>;
  parts: number;
  /** Packed bytes, headers included. */
  bytes: number;
}

/** Reads `files` (checkout-relative) in one pack command and a few part reads. Throws if any of it fails. */
export async function bulkReadFiles(sandbox: BulkReadSandbox, files: string[], limits: BulkReadLimits = BULK_READ_LIMITS): Promise<BulkReadResult> {
  if (files.length === 0) return { files: new Map(), parts: 0, bytes: 0 };
  const id = randomBytes(6).toString("hex");
  const list = `bulk-${id}.json`;
  const prefix = `bulk-${id}-`;
  const dir = sandbox.privateFilesDir;
  await sandbox.writePrivateFiles([{ name: list, content: JSON.stringify(files) }]);
  try {
    const args = [`${dir}/${list}`, `${dir}/${prefix}`, String(limits.partBytes), String(limits.maxFileBytes), String(limits.maxTotalBytes)];
    const packed = await sandbox.exec(["node", "-e", BULK_PACK_SCRIPT, "--", ...args], { timeoutMs: PACK_TIMEOUT_MS });
    if (packed.exitCode !== 0) throw new WorkspaceError(`Packing the checkout failed (exit ${packed.exitCode}${packed.timedOut ? ", timed out" : ""})`);
    const summary = parseSummary(packed.stdout);
    const unpacker = new BulkUnpacker(files, limits.maxFileBytes);
    await inOrder(summary.parts, limits.concurrency, async (n) => {
      const bytes = await sandbox.readPrivateBytes(`${prefix}${n}`);
      if (!bytes) throw new WorkspaceError(`Packed part ${n} is missing`);
      return bytes;
    }, (bytes) => unpacker.push(bytes));
    return { files: unpacker.finish(), parts: summary.parts, bytes: summary.bytes };
  } finally {
    await sandbox.exec(["sh", "-c", 'rm -f -- "$1" "$2"*', "sh", `${dir}/${list}`, `${dir}/${prefix}`], { timeoutMs: 60_000 }).catch(() => {});
  }
}

function parseSummary(stdout: string): { parts: number; bytes: number } {
  let summary: { parts?: unknown; bytes?: unknown };
  try {
    summary = JSON.parse(stdout) as typeof summary;
  } catch {
    throw new WorkspaceError("Packing the checkout gave no summary");
  }
  const { parts, bytes } = summary;
  if (!Number.isInteger(parts) || (parts as number) < 1 || !Number.isInteger(bytes)) throw new WorkspaceError("Packing the checkout gave a bad summary");
  return { parts: parts as number, bytes: bytes as number };
}

/** Fetches parts `0..count-1`, at most `concurrency` ahead, and hands them to `use` in order. */
async function inOrder(count: number, concurrency: number, fetch: (n: number) => Promise<Buffer>, use: (bytes: Buffer) => void): Promise<void> {
  const pending: Array<Promise<Buffer> | undefined> = [];
  let next = 0;
  const start = () => {
    if (next >= count) return;
    const fetched = fetch(next);
    // Awaited below in order; this only keeps a failure after an earlier one from going unhandled.
    fetched.catch(() => {});
    pending[next++] = fetched;
  };
  for (let i = 0; i < Math.max(1, concurrency); i++) start();
  for (let n = 0; n < count; n++) {
    const bytes = await pending[n]!;
    pending[n] = undefined;
    start();
    use(bytes);
  }
}

/** Unpacks the stream part by part, a record split across parts included. Text is decoded as UTF-8. */
export class BulkUnpacker {
  private pending = Buffer.alloc(0);
  private started = false;
  private ended = false;
  private records = 0;
  private last = -1;
  private readonly out = new Map<string, string | undefined>();

  constructor(
    private readonly files: readonly string[],
    private readonly maxFileBytes = BULK_READ_LIMITS.maxFileBytes,
  ) {}

  push(chunk: Uint8Array): void {
    if (this.ended) {
      if (chunk.byteLength > 0) throw bad("data after the end");
      return;
    }
    const piece = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const buf = this.pending.length ? Buffer.concat([this.pending, piece]) : piece;
    let at = 0;
    if (!this.started) {
      if (buf.length < MAGIC.length) return void (this.pending = Buffer.from(buf));
      if (buf.toString("latin1", 0, MAGIC.length) !== MAGIC) throw bad("not a packed stream");
      this.started = true;
      at = MAGIC.length;
    }
    while (buf.length - at >= HEADER) {
      const kind = buf[at]!;
      const index = buf.readUInt32BE(at + 1);
      const length = buf.readUInt32BE(at + 5);
      if (kind === 2) {
        if (index !== this.records || length !== 0 || at + HEADER !== buf.length) throw bad("a bad end");
        this.ended = true;
        at += HEADER;
        break;
      }
      if ((kind !== 0 && kind !== 1) || index <= this.last || index >= this.files.length || length > this.maxFileBytes || (kind === 0 && length !== 0)) throw bad("a bad record");
      if (buf.length - at - HEADER < length) break;
      const body = buf.subarray(at + HEADER, at + HEADER + length);
      this.out.set(this.files[index]!, kind === 1 ? body.toString("utf8") : undefined);
      this.last = index;
      this.records++;
      at += HEADER + length;
    }
    // A copy, so the part it came from can be freed.
    this.pending = Buffer.from(buf.subarray(at));
  }

  /** The files read; throws if the stream stopped before its end. */
  finish(): Map<string, string | undefined> {
    if (!this.ended) throw bad("it ends early");
    return this.out;
  }
}

function bad(what: string): WorkspaceError {
  return new WorkspaceError(`Packed checkout stream is corrupt: ${what}`);
}
