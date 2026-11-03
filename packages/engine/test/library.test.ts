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

/**
 * A fake network: `routes` answers by URL, and anything else answers 200 like
 * an internal service would. Redirects are followed unless the caller asks for
 * `redirect: "manual"`, as real fetch does. Every URL requested is recorded.
 */
function network(routes: Record<string, () => Response>) {
  const requested: string[] = [];
  const fake = (async (input: string | URL, init?: RequestInit) => {
    let url = String(input);
    for (;;) {
      requested.push(url);
      const response = routes[url]?.() ?? new Response(zip({ "leak.php": "function verify() { return 'internal'; }" }));
      const location = response.headers.get("location");
      if (init?.redirect === "manual" || !location) return response;
      url = new URL(location, url).href;
    }
  }) as unknown as typeof fetch;
  return { fake, requested };
}

const redirect = (to: string) => () => new Response(null, { status: 302, headers: { location: to } });

describe("fetchLibrary only downloads from registry hosts", () => {
  const packagist = "https://repo.packagist.org/p2/acme/app.json";
  const meta = (url: string) => () => Response.json({ packages: { "acme/app": [{ version: "1.0.0", dist: { url } }] } });

  test("a Packagist dist URL on an internal host is never fetched", async () => {
    const { fake, requested } = network({ [packagist]: meta("http://169.254.169.254/latest/meta-data/") });
    await expect(fetchLibrary({ ecosystem: "Packagist", name: "acme/app", version: "1.0.0" }, fake)).rejects.toThrow();
    expect(requested).toEqual([packagist]);
  });

  test("a PyPI wheel URL off the registry is never fetched", async () => {
    const release = "https://pypi.org/pypi/acme/1.0.0/json";
    const { fake, requested } = network({
      [release]: () => Response.json({ urls: [{ url: "https://10.0.0.5/acme-1.0.0-py3-none-any.whl", packagetype: "bdist_wheel", filename: "acme-1.0.0-py3-none-any.whl" }] }),
    });
    await expect(fetchLibrary({ ecosystem: "PyPI", name: "acme", version: "1.0.0" }, fake)).rejects.toThrow();
    expect(requested).toEqual([release]);
  });

  test("a registry redirect to an internal host is not followed", async () => {
    const tgz = "https://registry.npmjs.org/acme/-/acme-1.0.0.tgz";
    const { fake, requested } = network({ [tgz]: redirect("http://127.0.0.1:6379/") });
    await expect(fetchLibrary({ ecosystem: "npm", name: "acme", version: "1.0.0" }, fake)).rejects.toThrow();
    expect(requested).toEqual([tgz]);
  });

  test("Packagist zipballs still download through the code host's redirect", async () => {
    const zipball = "https://api.github.com/repos/acme/app/zipball/abc123";
    const codeload = "https://codeload.github.com/acme/app/legacy.zip/abc123";
    const { fake, requested } = network({
      [packagist]: meta(zipball),
      [zipball]: redirect(codeload),
      [codeload]: () => new Response(zip({ "acme-app-abc123/src/Verify.php": "function verify() {}" })),
    });
    const files = await fetchLibrary({ ecosystem: "Packagist", name: "acme/app", version: "1.0.0" }, fake);
    expect(files.map((f) => f.path)).toEqual(["acme-app-abc123/src/Verify.php"]);
    expect(requested).toEqual([packagist, zipball, codeload]);
  });
});

describe("fetchLibrary bounds what an archive unpacks to", () => {
  test("a gzip that inflates past the cap is refused with a catchable error", async () => {
    // ~260 KB on the wire, 260 MB of zeros once inflated.
    const bomb = Bun.gzipSync(new Uint8Array(260 * 1024 * 1024));
    const fake = (async () => new Response(bomb)) as unknown as typeof fetch;
    await expect(fetchLibrary({ ecosystem: "npm", name: "acme", version: "1.0.0" }, fake)).rejects.toThrow(/too large/);
  });

  test("a zip entry is never inflated past the source-file cap", () => {
    const [, big] = readZip(zip({ "m/a.go": "package m", "m/big.go": "a".repeat(8 * 1024 * 1024) }));
    expect(() => big!.data()).toThrow();
  });

  test("a zip whose sources together inflate past the cap is refused", async () => {
    const files = Object.fromEntries(Array.from({ length: 700 }, (_, i) => [`m/f${i}.go`, "a".repeat(399 * 1024)]));
    const archive = zip(files);
    const fake = (async () => new Response(archive)) as unknown as typeof fetch;
    await expect(fetchLibrary({ ecosystem: "Go", name: "example.com/m", version: "v1.0.0" }, fake)).rejects.toThrow(/too large/);
  });

  test("oversized zip entries are skipped and the rest still read", async () => {
    const archive = zip({ "m/a.go": "func A() {}", "m/big.go": "a".repeat(8 * 1024 * 1024), "m/b.go": "func B() {}" });
    const fake = (async () => new Response(archive)) as unknown as typeof fetch;
    const files = await fetchLibrary({ ecosystem: "Go", name: "example.com/m", version: "v1.0.0" }, fake);
    expect(files.map((f) => f.path)).toEqual(["m/a.go", "m/b.go"]);
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
