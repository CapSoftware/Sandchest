import { describe, expect, test } from "bun:test";
import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import type { Finding } from "@sandchest/engine/scan";
import { appJwt, checkResult, GitHubApp, githubPaginate, githubRequest, parsePatch, reviewBody, reviewComment, verifySignature } from "../src";

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
