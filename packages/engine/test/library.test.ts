import { describe, expect, test } from "bun:test";
import { crc32, deflateRawSync } from "node:zlib";
import { fetchLibrary, findDefinitions, readTar, readZip } from "../src/scan/library";

const enc = new TextEncoder();

/** A minimal ustar archive; names over 100 bytes use a GNU long-name entry. */
function tar(files: Record<string, string>): Uint8Array {
  const blocks: Uint8Array[] = [];
  const header = (name: string, size: number, type: string) => {
    const h = new Uint8Array(512);
    h.set(enc.encode(name.slice(0, 100)), 0);
    h.set(enc.encode(size.toString(8).padStart(11, "0")), 124);
    h[156] = type.charCodeAt(0);
    return h;
  };
  const body = (data: Uint8Array) => {
    const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
    padded.set(data);
    return padded;
  };
  for (const [name, text] of Object.entries(files)) {
    const data = enc.encode(text);
    if (name.length > 100) {
      blocks.push(header("././@LongLink", name.length + 1, "L"), body(enc.encode(`${name}\0`)));
    }
    blocks.push(header(name, data.length, "0"), body(data));
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of blocks) (out.set(b, at), (at += b.length));
  return out;
}

/** A minimal zip: the first file stored, the rest deflated. */
function zip(files: Record<string, string>): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  Object.entries(files).forEach(([name, text], i) => {
    const raw = enc.encode(text);
    const method = i === 0 ? 0 : 8;
    const data = method === 0 ? raw : new Uint8Array(deflateRawSync(raw));
    const nameBytes = enc.encode(name);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc32(raw), true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  });
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, end];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
}

describe("archives", () => {
  test("reads tar entries, including GNU long names", () => {
    const long = `pkg/${"deep/".repeat(25)}lib.rs`;
    const entries = readTar(tar({ "pkg/src/lib.rs": "pub fn a() {}", [long]: "fn b() {}" }));
    expect(entries.map((e) => e.path)).toEqual(["pkg/src/lib.rs", long]);
    expect(new TextDecoder().decode(entries[1]!.data)).toBe("fn b() {}");
  });

  test("reads stored and deflated zip entries", () => {
    const entries = readZip(zip({ "a/stored.go": "package a", "a/deflated.go": "func Parse() {}".repeat(20) }));
    expect(entries.map((e) => e.path)).toEqual(["a/stored.go", "a/deflated.go"]);
    expect(new TextDecoder().decode(entries[1]!.data())).toBe("func Parse() {}".repeat(20));
  });
});

describe("fetchLibrary", () => {
  test("downloads the exact version from the ecosystem's registry, and keeps only source", async () => {
    const urls: string[] = [];
    const fake = (async (url: string) => {
      urls.push(url);
      return new Response(Bun.gzipSync(tar({ "totp-rs-6.0.0/src/lib.rs": "pub fn check_current(&self, token: &str) -> Option<u64> { None }", "totp-rs-6.0.0/README.md": "docs", "totp-rs-6.0.0/tests/t.rs": "fn t() {}" }) as Uint8Array<ArrayBuffer>));
    }) as unknown as typeof fetch;
    const files = await fetchLibrary({ ecosystem: "crates.io", name: "totp-rs", version: "6.0.0" }, fake);
    expect(urls).toEqual(["https://static.crates.io/crates/totp-rs/totp-rs-6.0.0.crate"]);
    expect(files.map((f) => f.path)).toEqual(["totp-rs-6.0.0/src/lib.rs"]);
  });

  test("Go module paths escape capitals and use the module proxy", async () => {
    const urls: string[] = [];
    const fake = (async (url: string) => (urls.push(url), new Response(zip({ "m/x.go": "func X() {}" })))) as unknown as typeof fetch;
    await fetchLibrary({ ecosystem: "Go", name: "github.com/Azure/go-autorest", version: "v1.2.3" }, fake);
    expect(urls[0]).toBe("https://proxy.golang.org/github.com/!azure/go-autorest/@v/v1.2.3.zip");
  });

  test("an unknown ecosystem reads nothing", async () => {
    expect(await fetchLibrary({ ecosystem: "Hex", name: "x", version: "1" })).toEqual([]);
  });
});

describe("findDefinitions", () => {
  const files = [
    { path: "totp/src/lib.rs", text: "impl Totp {\n    pub fn check_current(&self, token: &str) -> Option<u64> {\n        self.check(token, now())\n    }\n}\n// check_current is handy\n" },
    { path: "jwt/verify.js", text: "const x = 1;\nmodule.exports = function (token, key) {\n  return check(token, key);\n};\n" },
    { path: "client/api.ts", text: "export class Client {\n  async fetchUser(id: string): Promise<User> {\n    return get(id);\n  }\n}\n" },
  ];

  test("finds Rust definitions and ignores mere mentions", () => {
    const [hit] = findDefinitions(files, "Totp.check_current");
    expect(hit).toStartWith("totp/src/lib.rs:2");
    expect(hit).toContain("-> Option<u64>");
    expect(findDefinitions(files, "Totp.check_current")).toHaveLength(1);
  });

  test("finds JS/TS class-method shorthand and modules that export the function", () => {
    expect(findDefinitions(files, "Client.fetchUser")[0]).toStartWith("client/api.ts:2");
    expect(findDefinitions(files, "verify")[0]).toStartWith("jwt/verify.js:2");
  });

  test("rejects names that are not identifiers", () => {
    expect(findDefinitions(files, "a.*")).toEqual([]);
  });
});
