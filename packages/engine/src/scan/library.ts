/**
 * Library source: read how a third-party dependency actually behaves, at the
 * exact version the repository installs.
 *
 * A whole class of false positive comes from the model remembering a library's
 * API wrong — an older signature, a different default, a return type that
 * changed between majors ("`check_current(..).is_some()` accepts any token" when
 * that version returns `None` for a wrong token). The repository does not
 * contain its dependencies, so neither the hunter nor the skeptic can check.
 * This fetches the published source of the installed version from its registry
 * and returns the definition, so the claim is judged on the real code.
 *
 * Language-agnostic: every ecosystem the indexer reads lockfiles for publishes a
 * per-version source archive — tar.gz (npm, crates.io, PyPI sdists, RubyGems) or
 * zip (Go modules, PyPI wheels, Maven source jars, Packagist). Downloads are
 * size- and time-capped and cached per process.
 */
import { inflateRawSync } from "node:zlib";

export interface LibraryRef {
  ecosystem: string;
  name: string;
  version: string;
}

export interface SourceFile {
  path: string;
  text: string;
}

const MAX_DOWNLOAD = 40 * 1024 * 1024;
const MAX_FILE = 400 * 1024;
const MAX_FILES = 6_000;
const FETCH_TIMEOUT_MS = 20_000;
const SOURCE = /\.(rs|rb|py|pyi|js|mjs|cjs|ts|mts|cts|go|java|kt|php|c|h|cc|cpp|hpp|cs|swift|scala|ex|exs)$/i;

// ---- archives ---------------------------------------------------------------

/** Entries of a tar archive (ustar, with GNU long names). */
export function readTar(bytes: Uint8Array): Array<{ path: string; data: Uint8Array }> {
  const out: Array<{ path: string; data: Uint8Array }> = [];
  const decoder = new TextDecoder();
  const field = (offset: number, length: number) => decoder.decode(bytes.subarray(offset, offset + length)).replace(/\0.*$/s, "");
  let offset = 0;
  let longName: string | undefined;
  while (offset + 512 <= bytes.length) {
    const name = field(offset, 100);
    if (!name) break;
    const size = Number.parseInt(field(offset + 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(bytes[offset + 156] ?? 48);
    const prefix = field(offset + 345, 155);
    const dataStart = offset + 512;
    const data = bytes.subarray(dataStart, dataStart + size);
    if (type === "L") {
      longName = decoder.decode(data).replace(/\0.*$/s, "");
    } else {
      if (type === "0" || type === "\0") out.push({ path: longName ?? (prefix ? `${prefix}/${name}` : name), data });
      longName = undefined;
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** Entries of a zip archive (stored or deflated; no zip64). */
export function readZip(bytes: Uint8Array): Array<{ path: string; data: () => Uint8Array }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) return [];
  const count = view.getUint16(end + 10, true);
  let cursor = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const out: Array<{ path: string; data: () => Uint8Array }> = [];
  for (let n = 0; n < count && cursor + 46 <= bytes.length; n++) {
    if (view.getUint32(cursor, true) !== 0x02014b50) break;
    const method = view.getUint16(cursor + 10, true);
    const compressed = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const local = view.getUint32(cursor + 42, true);
    const path = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;
    if (path.endsWith("/") || local + 30 > bytes.length) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + compressed);
    if (method !== 0 && method !== 8) continue;
    out.push({ path, data: () => (method === 0 ? raw : new Uint8Array(inflateRawSync(raw))) });
  }
  return out;
}

// ---- registries -------------------------------------------------------------

type Fetch = typeof fetch;

async function download(url: string, fetchImpl: Fetch): Promise<Uint8Array> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
  if (!response.ok) throw new Error(`${response.status} from ${new URL(url).host}`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_DOWNLOAD) throw new Error("archive too large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_DOWNLOAD) throw new Error("archive too large");
  return bytes;
}

async function json(url: string, fetchImpl: Fetch): Promise<any> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${response.status} from ${new URL(url).host}`);
  return response.json();
}

const gunzip = (bytes: Uint8Array) => Bun.gunzipSync(bytes as Uint8Array<ArrayBuffer>);

function sources(entries: Array<{ path: string; data: Uint8Array | (() => Uint8Array) }>): SourceFile[] {
  const decoder = new TextDecoder();
  const files: SourceFile[] = [];
  for (const entry of entries) {
    if (files.length >= MAX_FILES) break;
    if (!SOURCE.test(entry.path) || /(^|\/)(tests?|spec|examples?|benches|__tests__)\//i.test(entry.path)) continue;
    const data = typeof entry.data === "function" ? entry.data() : entry.data;
    if (data.length > MAX_FILE) continue;
    files.push({ path: entry.path, text: decoder.decode(data) });
  }
  return files;
}

/** Go module paths escape capitals as `!` + lowercase. */
const goEscape = (path: string) => path.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);

/** The published source of one library version. */
export async function fetchLibrary(ref: LibraryRef, fetchImpl: Fetch = fetch): Promise<SourceFile[]> {
  const { name, version } = ref;
  switch (ref.ecosystem) {
    case "npm": {
      const base = name.startsWith("@") ? name.split("/")[1]! : name;
      return sources(readTar(gunzip(await download(`https://registry.npmjs.org/${name}/-/${base}-${version}.tgz`, fetchImpl))));
    }
    case "crates.io":
      return sources(readTar(gunzip(await download(`https://static.crates.io/crates/${name}/${name}-${version}.crate`, fetchImpl))));
    case "RubyGems": {
      const gem = readTar(await download(`https://rubygems.org/downloads/${name}-${version}.gem`, fetchImpl));
      const data = gem.find((entry) => entry.path === "data.tar.gz");
      return data ? sources(readTar(gunzip(data.data))) : [];
    }
    case "PyPI": {
      const release = await json(`https://pypi.org/pypi/${name}/${version}/json`, fetchImpl);
      const urls: Array<{ url: string; packagetype: string; filename: string }> = release.urls ?? [];
      const wheel = urls.find((u) => u.packagetype === "bdist_wheel" && u.filename.endsWith("none-any.whl")) ?? urls.find((u) => u.packagetype === "bdist_wheel");
      if (wheel) return sources(readZip(await download(wheel.url, fetchImpl)));
      const sdist = urls.find((u) => u.packagetype === "sdist" && u.filename.endsWith(".tar.gz"));
      return sdist ? sources(readTar(gunzip(await download(sdist.url, fetchImpl)))) : [];
    }
    case "Go":
      return sources(readZip(await download(`https://proxy.golang.org/${goEscape(name)}/@v/${version}.zip`, fetchImpl)));
    case "Maven": {
      const [group, artifact] = name.split(":");
      if (!group || !artifact) return [];
      const url = `https://repo1.maven.org/maven2/${group.replaceAll(".", "/")}/${artifact}/${version}/${artifact}-${version}-sources.jar`;
      return sources(readZip(await download(url, fetchImpl)));
    }
    case "Packagist": {
      const meta = await json(`https://repo.packagist.org/p2/${name}.json`, fetchImpl);
      const versions: Array<{ version: string; version_normalized?: string; dist?: { url: string } }> = meta.packages?.[name] ?? [];
      const bare = version.replace(/^v/, "");
      const match = versions.find((v) => v.version.replace(/^v/, "") === bare);
      return match?.dist?.url ? sources(readZip(await download(match.dist.url, fetchImpl))) : [];
    }
    default:
      return [];
  }
}

// ---- lookup -----------------------------------------------------------------

const DEFINES = /\b(?:fn|def|function|func|class|struct|trait|interface|module|enum|type|impl|const|let|var|val|public|private|protected|static|async|export)\b/;

/**
 * Where `symbol` is defined in the library, best first, each with surrounding
 * lines. `symbol` may be qualified (`Totp.check_current`): the last segment is
 * searched, and files or lines mentioning the qualifier rank higher.
 */
export function findDefinitions(files: SourceFile[], symbol: string, options: { limit?: number; context?: number } = {}): string[] {
  const parts = symbol.split(/::|\.|#/).filter(Boolean);
  const name = parts.at(-1);
  if (!name || !/^[\w$!?]+$/.test(name)) return [];
  const qualifier = parts.length > 1 ? parts.at(-2)! : undefined;
  const escaped = name.replace(/[$!?]/g, (c) => `\\${c}`);
  const word = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`);
  const hits: Array<{ score: number; text: string }> = [];
  for (const file of files) {
    const lines = file.text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!word.test(line)) continue;
      const defines =
        DEFINES.test(line.slice(0, line.search(word) + 1)) ||
        // `name: function`, `name = (…) =>`, `exports.name = …`
        new RegExp(`${escaped}\\s*[:=]\\s*(?:function|\\(|async|lambda|[\\w$]+\\s*=>)`).test(line) ||
        new RegExp(`exports\\.${escaped}\\s*=`).test(line) ||
        // JS/TS class-method shorthand: `  async name(a, b) {`
        new RegExp(`^\\s*(?:(?:async|static|get|set|override|readonly)\\s+)*${escaped}\\s*(?:<[^>]*>)?\\([^)]*\\)?\\s*(?::[^{]*)?\\{?\\s*$`).test(line);
      if (!defines) continue;
      let score = 2;
      if (/\b(?:fn|def|function|func)\s/.test(line)) score += 2;
      if (qualifier && (file.text.includes(qualifier) || file.path.toLowerCase().includes(qualifier.toLowerCase()))) score += 1;
      if (/\bpub\b|\bexport\b|\bpublic\b/.test(line)) score += 1;
      const context = options.context ?? 30;
      const start = Math.max(0, i - 6);
      const end = Math.min(lines.length, i + context);
      const body = lines
        .slice(start, end)
        .map((text, k) => `${String(start + k + 1).padStart(5)}| ${text}`)
        .join("\n");
      hits.push({ score, text: `${file.path}:${i + 1}\n${body}` });
    }
  }
  // A module that *is* the function (`verify.js` exporting it): show the export.
  if (hits.length === 0) {
    const file = files.find((f) => f.path.split("/").pop()!.replace(/\.\w+$/, "") === name);
    const lines = file?.text.split("\n") ?? [];
    const at = lines.findIndex((line) => /module\.exports\s*=|export\s+default/.test(line));
    if (file && at >= 0) {
      const end = Math.min(lines.length, at + (options.context ?? 30));
      const body = lines
        .slice(at, end)
        .map((text, k) => `${String(at + k + 1).padStart(5)}| ${text}`)
        .join("\n");
      hits.push({ score: 1, text: `${file.path}:${at + 1}\n${body}` });
    }
  }
  return hits
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit ?? 3)
    .map((hit) => hit.text);
}

const cache = new Map<string, Promise<SourceFile[]>>();

/** Cached `fetchLibrary`: one download per library version per process. */
export function librarySource(ref: LibraryRef, fetchImpl?: Fetch): Promise<SourceFile[]> {
  const key = `${ref.ecosystem}:${ref.name}@${ref.version}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = fetchLibrary(ref, fetchImpl);
    pending.catch(() => cache.delete(key));
    cache.set(key, pending);
  }
  return pending;
}
