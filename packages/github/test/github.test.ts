import { describe, expect, test } from "bun:test";
import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import type { Finding } from "@sandchest/engine/scan";
import { appJwt, checkResult, GitHubApp, githubPaginate, githubRequest, parsePatch, prSummary, prSummaryUnfinished, reviewBody, reviewComment, SUMMARY_MARKER, verifySignature } from "../src";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const config = { appId: "123", privateKey: pem, webhookSecret: "s3cret" };
const quick = { maxBackoffMs: 1 };

/** A fetch that answers with scripted responses and records requests. */
function scripted(...responses: Array<Response | (() => Response) | Error>) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no response scripted");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, requests };
}

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, ...init, headers: { "content-type": "application/json", ...init.headers } });

describe("client", () => {
  test("retries 5xx, network errors and rate limits, then succeeds", async () => {
    const { fetch, requests } = scripted(
      new Response("boom", { status: 502 }),
      new TypeError("socket hang up"),
      json({ message: "API rate limit exceeded" }, { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "0" } }),
      json({ ok: true }),
    );
    const result = await githubRequest(async () => "t", "/x", {}, { fetch, ...quick, maxAttempts: 5 });
    expect(result).toEqual({ ok: true });
    expect(requests).toHaveLength(4);
  });

  test("does not retry client errors", async () => {
    const { fetch, requests } = scripted(json({ message: "Not Found" }, { status: 404 }));
    await expect(githubRequest(async () => "t", "/x", {}, { fetch, ...quick })).rejects.toThrow("GitHub 404: Not Found");
    expect(requests).toHaveLength(1);
  });

  test("follows pagination links", async () => {
    const { fetch, requests } = scripted(
      json([1, 2], { headers: { link: '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=3>; rel="last"' } }),
      json([3]),
    );
    expect(await githubPaginate(async () => "t", "/x", (page: number[]) => page, {}, { fetch })).toEqual([1, 2, 3]);
    expect(requests[0]!.url).toContain("per_page=100");
  });
});

describe("app auth", () => {
  test("signs a verifiable JWT for the app", () => {
    const token = appJwt(config, 1_700_000_000_000);
    const [header, payload, signature] = token.split(".");
    expect(createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toEqual({ iat: 1_699_999_940, exp: 1_700_000_480, iss: "123" });
  });

  test("caches installation tokens until near expiry, and scopes clone tokens", async () => {
    const later = new Date(Date.now() + 60 * 60_000).toISOString();
    const { fetch, requests } = scripted(json({ token: "inst", expires_at: later }), json({ token: "clone", expires_at: later }));
    const app = new GitHubApp(config, { fetch, ...quick });
    const [a, b] = await Promise.all([app.token(7), app.token(7)]);
    expect([a, b]).toEqual(["inst", "inst"]);
    expect(await app.installation(7).cloneToken(42)).toBe("clone");
    expect(requests).toHaveLength(2);
    expect(JSON.parse(requests[1]!.init.body as string)).toEqual({ repository_ids: [42], permissions: { contents: "read" } });
  });

  test("refreshes a token that is about to expire", async () => {
    const soon = new Date(Date.now() + 60_000).toISOString();
    const later = new Date(Date.now() + 60 * 60_000).toISOString();
    const { fetch } = scripted(json({ token: "old", expires_at: soon }), json({ token: "new", expires_at: later }));
    const app = new GitHubApp(config, { fetch, ...quick });
    expect(await app.token(7)).toBe("old");
    expect(await app.token(7)).toBe("new");
  });

  test("reads an org membership with the installation's token, with the account id behind the username", async () => {
    const later = new Date(Date.now() + 60 * 60_000).toISOString();
    const { fetch, requests } = scripted(
      json({ token: "inst", expires_at: later }),
      json({ state: "active", role: "admin", user: { id: 202, login: "alice" } }),
      json({ message: "Not Found" }, { status: 404 }),
      json({ message: "Resource not accessible by integration" }, { status: 403 }),
    );
    const installation = new GitHubApp(config, { fetch, ...quick }).installation(7);
    expect(await installation.orgMembership("acme", "alice")).toEqual({ userId: 202, state: "active", role: "admin" });
    expect(await installation.orgMembership("acme", "dave")).toBeNull();
    await expect(installation.orgMembership("acme", "erin")).rejects.toThrow("403");
    expect(requests[1]!.url).toBe("https://api.github.com/orgs/acme/memberships/alice");
  });

  test("a 404 getting the token (the app was uninstalled) is an error, not 'not a member'", async () => {
    const { fetch, requests } = scripted(json({ message: "Not Found" }, { status: 404 }));
    await expect(new GitHubApp(config, { fetch, ...quick }).installation(7).orgMembership("acme", "alice")).rejects.toThrow("404");
    expect(requests.map((r) => new URL(r.url).pathname)).toEqual(["/app/installations/7/access_tokens"]);
  });
});

describe("webhooks", () => {
  test("verifies signatures in constant time", () => {
    const body = '{"action":"opened"}';
    const signature = `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;
    expect(verifySignature("s3cret", body, signature)).toBe(true);
    expect(verifySignature("s3cret", `${body} `, signature)).toBe(false);
    expect(verifySignature("other", body, signature)).toBe(false);
    expect(verifySignature("s3cret", body, null)).toBe(false);
  });
});

describe("diff", () => {
  test("finds added and commentable lines in the new file", () => {
    const patch = "@@ -10,4 +10,5 @@ function a() {\n context\n-removed\n+added one\n+added two\n context\n@@ -40 +41,2 @@\n+tail\n end\n";
    const diff = parsePatch("a.ts", patch);
    expect([...diff.added]).toEqual([11, 12, 41]);
    expect([...diff.commentable]).toEqual([10, 11, 12, 13, 41, 42]);
    expect(diff.hunks).toEqual([[10, 14], [41, 42]]);
  });

  test("handles files without a patch", () => {
    expect(parsePatch("logo.png", undefined).hunks).toEqual([]);
    expect(parsePatch("logo.png", undefined).changed).toEqual([]);
  });

  test("changed ranges are the added lines only, as a zero-context diff shows them", () => {
    const patch = "@@ -10,4 +10,5 @@ function a() {\n context\n-removed\n+added one\n+added two\n context\n@@ -40 +41,2 @@\n+tail\n end\n";
    expect(parsePatch("a.ts", patch).changed).toEqual([[11, 12], [41, 41]]);
    // A replacement is one run; context splits runs; a pure deletion and the no-newline marker add none.
    const mixed = ["@@ -1,9 +1,9 @@", "-old a", "+new a", "-old b", "+new b", " same", "+inserted", " same", "-gone", " same", "\\ No newline at end of file", "@@ -20,3 +20,2 @@", " keep", "-drop", " keep"].join("\n");
    expect(parsePatch("b.ts", mixed).changed).toEqual([[1, 2], [4, 4]]);
    // A new file is one run.
    expect(parsePatch("c.ts", "@@ -0,0 +1,3 @@\n+a\n+b\n+c").changed).toEqual([[1, 3]]);
  });
});

describe("file contents", () => {
  const later = () => new Date(Date.now() + 60 * 60_000).toISOString();
  const encoded = (text: string) => Buffer.from(text).toString("base64").replace(/(.{60})/g, "$1\n");

  test("reads a file's text at a commit, by path and ref, with the installation's token", async () => {
    const text = "export const a = 1;\n// ünïcode\n".repeat(20);
    const { fetch, requests } = scripted(json({ token: "inst", expires_at: later() }), json({ type: "file", size: Buffer.byteLength(text), encoding: "base64", content: encoded(text) }));
    const installation = new GitHubApp(config, { fetch, ...quick }).installation(7);
    expect(await installation.fileAt("acme/app", "src/api/a b#.ts", "abc123")).toBe(text);
    expect(requests[1]!.url).toBe("https://api.github.com/repos/acme/app/contents/src/api/a%20b%23.ts?ref=abc123");
    expect((requests[1]!.init.headers as Record<string, string>).authorization).toBe("Bearer inst");
  });

  test("no file, a directory, a link, a file over 1 MiB: undefined; anything else is thrown", async () => {
    const { fetch } = scripted(
      json({ token: "inst", expires_at: later() }),
      json({ message: "Not Found" }, { status: 404 }),
      json([{ type: "file", name: "a.ts" }]),
      json({ type: "symlink", size: 10, target: "../x" }),
      json({ type: "file", size: 1024 * 1024 + 1, encoding: "none", content: "" }),
      json({ type: "file", size: 1024 * 1024, encoding: "base64", content: encoded("x") }),
      json({ message: "Forbidden" }, { status: 403 }),
    );
    const installation = new GitHubApp(config, { fetch, ...quick }).installation(7);
    expect(await installation.fileAt("acme/app", "gone.ts", "abc")).toBeUndefined();
    expect(await installation.fileAt("acme/app", "src", "abc")).toBeUndefined();
    expect(await installation.fileAt("acme/app", "link.ts", "abc")).toBeUndefined();
    expect(await installation.fileAt("acme/app", "big.ts", "abc")).toBeUndefined();
    expect(await installation.fileAt("acme/app", "edge.ts", "abc")).toBe("x");
    await expect(installation.fileAt("acme/app", "secret.ts", "abc")).rejects.toThrow("403");
  });
});

const finding = (severity: Finding["severity"], confidence: Finding["confidence"] = "high"): Finding => ({
  fingerprint: `fp-${severity}`,
  title: `A ${severity} bug with <html>`,
  severity,
  confidence,
  category: "sql_injection",
  cwe: "CWE-89",
  impact: "Reads every invoice.",
  mitigations: "",
  entryPoint: { file: "a.ts", line: 1, description: "GET /x" },
  attackPath: [{ file: "a.ts", line: 3, note: "sink", excerpt: "3| secret code" }],
  attacker: "unauthenticated",
  preconditions: "Anyone.",
  proofOfConcept: "GET /x?q='",
  fixGuidance: "Bind it.",
  guarantees: [],
  mustNotBreak: [],
  regressionTest: "",
  fixPrompt: "Fix this ```weird``` thing",
  leads: [],
  skeptic: { confidence, reasoning: "" },
});

describe("render", () => {
  test("fails the Check at the threshold and ignores low-confidence findings", () => {
    const base = { threshold: "high" as const, isPublic: false, detailsUrl: "https://app/x" };
    expect(checkResult({ ...base, findings: [finding("medium")] }).conclusion).toBe("success");
    expect(checkResult({ ...base, findings: [finding("critical", "low")] }).conclusion).toBe("success");
    expect(checkResult({ ...base, findings: [finding("high")] }).conclusion).toBe("failure");
    expect(checkResult({ ...base, findings: [] }).output.title).toBe("Nothing buried here");
  });

  test("trust does not gate the build (it didn't separate real from false); severity does", () => {
    const base = { threshold: "high" as const, isPublic: false, detailsUrl: "https://app/x" };
    // An unconfirmed high still blocks — unconfirmed real findings are common, so trust must not suppress the block.
    expect(checkResult({ ...base, findings: [{ ...finding("high"), trust: "unconfirmed" }] }).conclusion).toBe("failure");
    expect(checkResult({ ...base, findings: [{ ...finding("critical"), trust: "corroborated" }] }).conclusion).toBe("failure");
    // Below threshold does not block, whatever the trust.
    expect(checkResult({ ...base, findings: [{ ...finding("medium"), trust: "corroborated" }] }).conclusion).toBe("success");
    // But a runtime-reproduced finding is dispositive and blocks even below threshold.
    const verified = { ...finding("medium"), validation: { status: "verified" as const, method: "two-tenant", detail: "" } };
    expect(checkResult({ ...base, findings: [verified] }).conclusion).toBe("failure");
  });

  test("public repos get counts and a link, never details", () => {
    const { output } = checkResult({ findings: [finding("high"), finding("low")], threshold: "high", isPublic: true, detailsUrl: "https://app/x", credits: 2 });
    const text = JSON.stringify(output);
    expect(output.summary).toContain("Sandchest found 1 high-severity issue and 1 more.");
    expect(output.summary).toContain("2 credits");
    for (const secret of ["A high bug", "a.ts", "secret code", "GET /x", "Reads every"]) expect(text).not.toContain(secret);
  });

  test("private comments carry the attack, proof and fix prompt", () => {
    const comment = reviewComment(finding("critical"));
    expect(comment).toContain("**Critical** · high confidence · CWE-89");
    expect(comment).toContain("`a.ts:3` — sink");
    expect(comment).toContain("<details><summary>Fix prompt for your coding agent</summary>");
    expect(comment).toContain("````\nFix this ```weird``` thing\n````");
    expect(reviewBody([finding("high")], [finding("high")], "https://app/x")).toContain("A high bug with &lt;html&gt;");
  });
});

describe("PR summary comment", () => {
  const linked = (severity: Finding["severity"], confidence: Finding["confidence"] = "high") => ({ ...finding(severity, confidence), url: "https://app/f/1" });
  const base = { headSha: "0123456789abcdef", detailsUrl: "https://app/scans/1", credits: 2 };

  test("says all is well, with the commit it reviewed", () => {
    const body = prSummary({ ...base, findings: [linked("high", "low")], isPublic: false });
    expect(body.startsWith(SUMMARY_MARKER)).toBe(true);
    expect(body).toContain("reviewed `0123456`: nothing exploitable found");
    expect(body).toContain("2 credits");
  });

  test("public repos get counts and a private link, never what or where", () => {
    const body = prSummary({ ...base, findings: [linked("high"), linked("medium")], isPublic: true });
    expect(body).toContain("found 2 issues in `0123456` (1 high, 1 medium)");
    expect(body).toContain("https://app/scans/1");
    for (const secret of ["A high bug", "a.ts", "secret code", "GET /x", "Reads every", "Bind it", "https://app/f/1"]) expect(body).not.toContain(secret);
  });

  test("private repos list each finding, linked, with its write-up folded away", () => {
    const body = prSummary({ ...base, findings: [linked("critical"), linked("high")], isPublic: false, inline: 1 });
    expect(body).toContain("found 2 issues in `0123456`: 1 critical, 1 high. 1 is also commented on the diff.");
    expect(body).toContain("| Critical | [A critical bug with &lt;html&gt;](https://app/f/1) | `a.ts:3` |");
    expect(body).toContain("<details><summary><b>Critical</b>");
    expect(body).toContain("**Proof of concept**");
  });

  test("table cells can't break the table or the link", () => {
    const tricky = { ...linked("high"), title: "Pipes | and [brackets]\nnewline" };
    const body = prSummary({ ...base, findings: [tricky], isPublic: false });
    expect(body).toContain("[Pipes \\| and \\[brackets\\] newline](https://app/f/1)");
  });

  test("a very long summary drops the write-ups, not the list", () => {
    const long = Array.from({ length: 40 }, (_, i) => ({ ...linked("high"), title: `Bug ${i}`, proofOfConcept: "x".repeat(3_000) }));
    const body = prSummary({ ...base, findings: long, isPublic: false });
    expect(body.length).toBeLessThan(60_000);
    expect(body).toContain("| High | [Bug 39]");
    expect(body).not.toContain("<details>");
  });

  test("the animated chest sits under the marker, above the result", () => {
    const body = prSummary({ ...base, findings: [linked("high")], isPublic: true, animationUrl: "https://app/github/review-chest.png?v=1" });
    expect(body.startsWith(`${SUMMARY_MARKER}\n\n<a href="https://app/scans/1"><img src="https://app/github/review-chest.png?v=1" alt="Sandchest" width="152" height="120"></a>\n\n**Sandchest** found 1 issue`)).toBe(true);
    expect(prSummary({ ...base, findings: [], isPublic: false })).not.toContain("<img");
  });

  test("findings still open from an earlier commit stay on the summary, with the commit that found them", () => {
    const older = (severity: Finding["severity"], headSha = "1a2b3c4d5e6f7a8b") => ({ ...linked(severity), title: `Old ${severity}`, foundIn: { headSha, detailsUrl: "https://app/scans/0" } });
    const quiet = prSummary({ ...base, findings: [], earlier: [older("medium")], isPublic: true });
    expect(quiet).toContain("reviewed `0123456`: nothing new found in this change.");
    expect(quiet).toContain("1 issue found in [`1a2b3c4`](https://app/scans/0) is still open (1 medium).");
    expect(quiet).not.toContain("nothing exploitable found");
    for (const secret of ["Old medium", "a.ts", "https://app/f/1"]) expect(quiet).not.toContain(secret);

    const both = prSummary({ ...base, findings: [linked("high")], earlier: [older("medium"), older("low", "abcdef0123")], isPublic: true });
    expect(both).toContain("found 1 issue in `0123456` (1 high).");
    expect(both).toContain("2 issues found in earlier commits are still open: 1 medium in [`1a2b3c4`](https://app/scans/0); 1 low in [`abcdef0`](https://app/scans/0).");

    const listed = prSummary({ ...base, findings: [], earlier: [older("low"), older("critical")], isPublic: false });
    expect(listed).toContain("reviewed `0123456`: nothing new found in this change.");
    expect(listed).toContain("| Severity | Issue | Where | Found in |");
    expect(listed.indexOf("| Critical | [Old critical]")).toBeLessThan(listed.indexOf("| Low | [Old low]"));
    expect(listed).toContain("| Critical | [Old critical](https://app/f/1) | `a.ts:3` | [`1a2b3c4`](https://app/scans/0) |");
    expect(listed).toContain("<details><summary><b>Critical</b> Old critical</summary>");
  });

  test("low-confidence earlier findings stay hidden, as they do on the review that found them", () => {
    const hidden = { ...linked("high", "low"), foundIn: { headSha: "1a2b3c4d", detailsUrl: "https://app/scans/0" } };
    expect(prSummary({ ...base, findings: [], earlier: [hidden], isPublic: false })).toContain("nothing exploitable found in this change.");
  });

  test("an unfinished review says so instead of leaving an older result standing", () => {
    expect(prSummaryUnfinished({ headSha: "abcdef0123", detailsUrl: "https://app/scans/2", reason: "failed" })).toContain("couldn't finish reviewing `abcdef0`. Comment `/sandchest review` to try again");
  });
});
