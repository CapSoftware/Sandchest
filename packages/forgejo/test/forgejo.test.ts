import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { parsePatch } from "@sandchest/github";
import { deliveryHeaders, Forgejo, loadForgejoConfig, splitDiff, statusState, verifySignature, type ForgejoConfig } from "../src";

const config: ForgejoConfig = {
  url: "https://git.example.com",
  apiUrl: "https://git.example.com/api/v1",
  gitUrl: "https://git.example.com",
  token: "bot-token",
  webhookSecret: "s3cret",
  owners: [{ owner: "acme" }],
  manageWebhooks: true,
};
const quick = { maxBackoffMs: 1 };

/** A fetch that answers with scripted responses and records requests. */
function scripted(...responses: Response[]) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no response scripted");
    return next;
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, requests };
}
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, ...init, headers: { "content-type": "application/json", ...init.headers } });

describe("webhooks", () => {
  const body = JSON.stringify({ action: "opened" });
  const signature = createHmac("sha256", "s3cret").update(body).digest("hex");

  test("accepts Forgejo's hex HMAC-SHA256 of the raw body, and nothing else", () => {
    expect(verifySignature("s3cret", body, signature)).toBe(true);
    expect(verifySignature("s3cret", body, signature.toUpperCase())).toBe(true);
    expect(verifySignature("wrong", body, signature)).toBe(false);
    expect(verifySignature("s3cret", `${body} `, signature)).toBe(false);
    // GitHub's prefixed form, truncated and missing signatures are refused.
    expect(verifySignature("s3cret", body, `sha256=${signature}`)).toBe(false);
    expect(verifySignature("s3cret", body, signature.slice(0, 62))).toBe(false);
    expect(verifySignature("s3cret", body, null)).toBe(false);
  });

  test("reads Forgejo's headers, or Gitea's", () => {
    const forgejo = new Headers({ "x-forgejo-event": "push", "x-forgejo-delivery": "d1", "x-forgejo-signature": "aa", "x-gitea-event": "push" });
    expect(deliveryHeaders(forgejo)).toEqual({ event: "push", delivery: "d1", signature: "aa" });
    const gitea = new Headers({ "x-gitea-event": "pull_request", "x-gitea-delivery": "d2", "x-gitea-signature": "bb" });
    expect(deliveryHeaders(gitea)).toEqual({ event: "pull_request", delivery: "d2", signature: "bb" });
    expect(deliveryHeaders(new Headers())).toEqual({ event: null, delivery: null, signature: null });
  });
});

describe("config", () => {
  const env = { FORGEJO_URL: "https://git.example.com/", FORGEJO_TOKEN: "t", FORGEJO_WEBHOOK_SECRET: "w", FORGEJO_OWNERS: "acme, someone/app" };

  test("is off without FORGEJO_URL", () => {
    expect(loadForgejoConfig({})).toBeUndefined();
    expect(loadForgejoConfig({ FORGEJO_URL: " " })).toBeUndefined();
  });

  test("reads owners and repositories, and derives the API and clone URLs", () => {
    expect(loadForgejoConfig(env)).toEqual({
      url: "https://git.example.com",
      apiUrl: "https://git.example.com/api/v1",
      gitUrl: "https://git.example.com",
      token: "t",
      webhookSecret: "w",
      owners: [{ owner: "acme" }, { owner: "someone", repo: "app" }],
      manageWebhooks: true,
    });
    expect(loadForgejoConfig({ ...env, FORGEJO_WEBHOOKS: "manual", FORGEJO_API_URL: "http://fake/api/v1/" })).toMatchObject({ manageWebhooks: false, apiUrl: "http://fake/api/v1" });
  });

  test("names what is missing or wrong", () => {
    expect(() => loadForgejoConfig({ FORGEJO_URL: "https://git.example.com" })).toThrow("FORGEJO_TOKEN, FORGEJO_WEBHOOK_SECRET, FORGEJO_OWNERS");
    expect(() => loadForgejoConfig({ ...env, FORGEJO_OWNERS: "a/b/c" })).toThrow('"a/b/c"');
    expect(() => loadForgejoConfig({ ...env, FORGEJO_OWNERS: "../x" })).toThrow();
    expect(() => loadForgejoConfig({ ...env, FORGEJO_WEBHOOKS: "yes" })).toThrow("FORGEJO_WEBHOOKS");
  });
});

describe("diff", () => {
  const diff = [
    "diff --git a/app.js b/app.js",
    "index 83db48f..bf269f4 100644",
    "--- a/app.js",
    "+++ b/app.js",
    "@@ -1,3 +1,3 @@",
    " const a = 1",
    "-const b = 2",
    "+const b = 3",
    " module.exports = a",
    "diff --git a/new.js b/new.js",
    "new file mode 100644",
    "index 0000000..e69de29",
    "--- /dev/null",
    "+++ b/new.js",
    "@@ -0,0 +1,2 @@",
    "+one",
    "+two",
    "diff --git a/gone.js b/gone.js",
    "deleted file mode 100644",
    "index e69de29..0000000",
    "--- a/gone.js",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-bye",
    "diff --git a/old name.js b/new name.js",
    "similarity index 90%",
    "rename from old name.js",
    "rename to new name.js",
    "index 1..2 100644",
    "--- a/old name.js\t",
    "+++ b/new name.js\t",
    "@@ -1 +1 @@",
    "-x",
    "+y",
    "diff --git a/logo.png b/logo.png",
    "index 1..2 100644",
    "Binary files a/logo.png and b/logo.png differ",
    'diff --git "a/caf\\303\\251.js" "b/caf\\303\\251.js"',
    "index 1..2 100644",
    '--- "a/caf\\303\\251.js"',
    '+++ "b/caf\\303\\251.js"',
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "",
  ].join("\n");

  test("splits a pull request's diff into files with patches, as GitHub lists them", () => {
    const files = splitDiff(diff);
    expect(files.map((f) => [f.filename, f.status, f.additions, f.deletions])).toEqual([
      ["app.js", "modified", 1, 1],
      ["new.js", "added", 2, 0],
      ["gone.js", "removed", 0, 1],
      ["new name.js", "renamed", 1, 1],
      ["logo.png", "modified", 0, 0],
      ["café.js", "modified", 1, 1],
    ]);
    expect(files[3]!.previous_filename).toBe("old name.js");
    expect(files[4]!.patch).toBeUndefined();
    expect(files[0]!.patch).toBe("@@ -1,3 +1,3 @@\n const a = 1\n-const b = 2\n+const b = 3\n module.exports = a");
  });

  test("its patches give the lines review comments may go on", () => {
    const [file] = splitDiff(diff);
    expect([...parsePatch(file!.filename, file!.patch).commentable]).toEqual([1, 2, 3]);
    expect([...parsePatch(file!.filename, file!.patch).added]).toEqual([2]);
  });

  test("an empty diff has no files", () => {
    expect(splitDiff("")).toEqual([]);
  });
});

describe("api", () => {
  test("maps Check conclusions to commit statuses that block merges only on failure", () => {
    expect(statusState("success")).toBe("success");
    expect(statusState("neutral")).toBe("success");
    expect(statusState("failure")).toBe("failure");
    expect(statusState("action_required")).toBe("failure");
    expect(statusState("cancelled")).toBe("error");
  });

  test("posts the status with the bot's token, and the review with new-file line numbers", async () => {
    const { fetch, requests } = scripted(json({ id: 9 }, { status: 201 }), json({ id: 1 }));
    const forgejo = new Forgejo(config, { fetch, ...quick });
    expect(await forgejo.setStatus("acme/app", "abc", { state: "pending", context: "Sandchest", description: "x".repeat(300), targetUrl: "https://s.test/scan" })).toBe(9);
    await forgejo.createReview("acme/app", 5, { commitId: "abc", body: "Summary", comments: [{ path: "app.js", line: 4, side: "RIGHT", body: "Here" }] });

    expect(requests[0]!.url).toBe("https://git.example.com/api/v1/repos/acme/app/statuses/abc");
    expect((requests[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer bot-token");
    const status = JSON.parse(requests[0]!.init.body as string);
    expect(status).toMatchObject({ state: "pending", context: "Sandchest", target_url: "https://s.test/scan" });
    expect(status.description).toHaveLength(255);
    expect(requests[1]!.url).toBe("https://git.example.com/api/v1/repos/acme/app/pulls/5/reviews");
    expect(JSON.parse(requests[1]!.init.body as string)).toEqual({ commit_id: "abc", event: "COMMENT", body: "Summary", comments: [{ path: "app.js", body: "Here", new_position: 4, old_position: 0 }] });
  });

  test("reads pull request files from the diff", async () => {
    const { fetch, requests } = scripted(new Response("diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-a\n+b\n"));
    const files = await new Forgejo(config, { fetch, ...quick }).pullFiles("acme/app", 5);
    expect(requests[0]!.url).toBe("https://git.example.com/api/v1/repos/acme/app/pulls/5.diff");
    expect(files).toEqual([{ filename: "a.js", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" }]);
  });

  test("compares commits by file name, on old and new Forgejo", async () => {
    const { fetch } = scripted(
      json({ files: [{ filename: "a.js", status: "modified" }] }),
      json({ commits: [{ files: [{ filename: "a.js", status: "added" }] }, { files: [{ filename: "a.js", status: "modified" }, { filename: "b.js", status: "deleted" }] }] }),
    );
    const forgejo = new Forgejo(config, { fetch, ...quick });
    expect((await forgejo.compare("acme/app", "1", "2")).map((f) => f.filename)).toEqual(["a.js"]);
    expect((await forgejo.compare("acme/app", "1", "2")).map((f) => [f.filename, f.status])).toEqual([["a.js", "modified"], ["b.js", "removed"]]);
  });

  test("finds organisations and users, and their repositories without archives, mirrors and empty ones", async () => {
    const repo = (id: number, extra = {}) => ({ id, full_name: `acme/r${id}`, private: true, default_branch: "main", ...extra });
    const { fetch, requests } = scripted(
      json({ id: 3, name: "acme", username: "acme" }),
      json({ message: "Not Found" }, { status: 404 }),
      json({ id: 4, login: "someone" }),
      json([repo(1), repo(2, { archived: true }), repo(3, { mirror: true }), repo(4, { empty: true })]),
    );
    const forgejo = new Forgejo(config, { fetch, ...quick });
    expect(await forgejo.owner("acme")).toEqual({ id: 3, login: "acme", type: "Organization" });
    expect(await forgejo.owner("someone")).toEqual({ id: 4, login: "someone", type: "User" });
    expect((await forgejo.repositories({ id: 3, login: "acme", type: "Organization" })).map((r) => r.id)).toEqual([1]);
    expect(requests[3]!.url).toBe("https://git.example.com/api/v1/orgs/acme/repos?limit=50&per_page=100");
  });

  test("follows pagination links to FORGEJO_API_URL, whatever address the instance builds them from", async () => {
    const repo = (id: number) => ({ id, full_name: `acme/r${id}`, private: true, default_branch: "main" });
    const { fetch, requests } = scripted(
      json([repo(1)], { headers: { link: '<http://git.internal/api/v1/orgs/acme/repos?limit=50&page=2>; rel="next", <http://git.internal/api/v1/orgs/acme/repos?limit=50&page=2>; rel="last"' } }),
      json([repo(2)]),
    );
    const forgejo = new Forgejo({ ...config, apiUrl: "http://forgejo:3000/api/v1" }, { fetch, ...quick });
    expect((await forgejo.repositories({ id: 3, login: "acme", type: "Organization" })).map((r) => r.id)).toEqual([1, 2]);
    expect(requests[1]!.url).toBe("http://forgejo:3000/api/v1/orgs/acme/repos?limit=50&page=2");
  });

  test("reads one repository, and leaves out archives, mirrors and empty ones as the listing does", async () => {
    const repo = (id: number, extra = {}) => ({ id, full_name: `acme/r${id}`, private: true, default_branch: "main", ...extra });
    const { fetch } = scripted(json(repo(1)), json(repo(2, { archived: true })), json(repo(3, { mirror: true })), json(repo(4, { empty: true })));
    const forgejo = new Forgejo(config, { fetch, ...quick });
    expect((await forgejo.repository("acme/r1"))?.id).toBe(1);
    for (const name of ["acme/r2", "acme/r3", "acme/r4"]) expect(await forgejo.repository(name)).toBeUndefined();
  });

  test("reads permissions in GitHub's words; strangers have none", async () => {
    const { fetch } = scripted(json({ permission: "owner" }), json({ permission: "write" }), json({ message: "forbidden" }, { status: 403 }));
    const forgejo = new Forgejo(config, { fetch, ...quick });
    expect(await forgejo.permission("acme/app", "a")).toBe("admin");
    expect(await forgejo.permission("acme/app", "b")).toBe("write");
    expect(await forgejo.permission("acme/app", "c")).toBe("none");
  });

  test("adds the webhook once", async () => {
    const hook = { id: 1, type: "gitea", active: true, config: { url: "https://s.test/api/forgejo/webhooks" } };
    const { fetch, requests } = scripted(json([]), json({ id: 1 }, { status: 201 }), json([hook]));
    const forgejo = new Forgejo(config, { fetch, ...quick });
    expect(await forgejo.ensureWebhook({ org: "acme" }, hook.config.url)).toBe(true);
    expect(JSON.parse(requests[1]!.init.body as string)).toEqual({
      type: "gitea",
      active: true,
      events: ["push", "pull_request", "issue_comment", "repository"],
      config: { url: hook.config.url, content_type: "json", secret: "s3cret" },
    });
    expect(await forgejo.ensureWebhook({ repo: "acme/app" }, hook.config.url)).toBe(false);
    expect(requests[2]!.url).toContain("/repos/acme/app/hooks");
  });

  test("names Forgejo in errors", async () => {
    const { fetch } = scripted(json({ message: "Not Found" }, { status: 404 }));
    await expect(new Forgejo(config, { fetch, ...quick }).branchSha("acme/app", "main")).rejects.toThrow("Forgejo 404: Not Found");
  });
});
