/**
 * The Forgejo path end to end, in-process: sync → recon, then signed
 * webhooks → scan workflow steps → engine → database → commit statuses,
 * reviews and comments, through the real Forgejo client against a fake
 * Forgejo API. Real: Postgres (local docker), git, the workspace, the indexer
 * and the engine. Fake: Forgejo's API and the model. Skips without a local
 * Postgres or an indexer build.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import postgres from "postgres";
import { createDb, dashboardRepos, openFindings, repoByGithubId, scanById, schema, settingsOrgs, threatModel, type Db } from "@sandchest/db";
import { migrate } from "@sandchest/db/migrate";
import type { ChatRequest, ChatResult, LlmClient, ToolCall } from "@sandchest/engine/llm";
import { Forgejo, loadForgejoConfig } from "@sandchest/forgejo";
import { POST } from "@/app/api/forgejo/webhooks/route";
import { storeForgejoAccess } from "@/server/access";
import { setAutumn } from "@/server/billing";
import { resetConfig } from "@/server/config";
import { setForgejoClient } from "@/server/forgejo";
import { forgejoDeps, syncForgejo } from "@/server/forgejo-sync";
import { beginScan, executeScan, publishScan } from "@/server/scans";
import { setServices } from "@/server/services";
import { setScanStarter } from "@/server/start";

const INDEXER = resolve(import.meta.dirname, "../../../target/release/sandchest-index");
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest";
const NAME = `sandchest_forgejo_test_${process.pid}`;
const SECRET = "forgejo-webhook-secret";

let admin: postgres.Sql | undefined;
let database: Db;
let available = existsSync(INDEXER);
const gitRoot = mkdtempSync(join(tmpdir(), "sandchest-forgejo-git-"));

const VULNERABLE = `const express = require("express")
const app = express()
app.post("/login", async (req, res) => {
  const rows = await db.query("SELECT * FROM users WHERE email = '" + req.body.email + "'")
  res.json(rows)
})
module.exports = app
`;
const FIXED = VULNERABLE.replace(`db.query("SELECT * FROM users WHERE email = '" + req.body.email + "'")`, `db.query("SELECT * FROM users WHERE email = $1", [req.body.email])`);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } })
    .toString()
    .trim();
}

function makeRepo(name: string, content: string): { work: string; head: string } {
  const work = join(gitRoot, `${name}-work`);
  execFileSync("mkdir", ["-p", work, join(gitRoot, "acme")]);
  git(work, "init", "-q", "-b", "main");
  writeFileSync(join(work, "app.js"), content);
  git(work, "add", ".");
  git(work, "commit", "-qm", "init");
  git(gitRoot, "clone", "-q", "--bare", work, join(gitRoot, "acme", `${name}.git`));
  return { work, head: git(work, "rev-parse", "HEAD") };
}

function pushCommit(name: string, work: string, content: string): string {
  writeFileSync(join(work, "app.js"), content);
  git(work, "commit", "-qam", "change");
  git(work, "push", "-q", join(gitRoot, "acme", `${name}.git`), "main");
  return git(work, "rev-parse", "HEAD");
}

// ---- Fake Forgejo ---------------------------------------------------------

const API = "http://forgejo.test/api/v1";
const owner = { id: 300, login: "acme" };
const repos = [
  { id: 11, full_name: "acme/private-app", private: true, default_branch: "main", owner },
  { id: 12, full_name: "acme/public-app", private: false, default_branch: "main", owner },
  { id: 13, full_name: "acme/old-app", private: true, default_branch: "main", owner, archived: true },
];
const DIFF = [
  "diff --git a/app.js b/app.js",
  "index 1..2 100644",
  "--- a/app.js",
  "+++ b/app.js",
  "@@ -1,7 +1,7 @@",
  ' const express = require("express")',
  " const app = express()",
  ' app.post("/login", async (req, res) => {',
  '-  const rows = await db.query("SELECT 1")',
  `+  const rows = await db.query("SELECT * FROM users WHERE email = '" + req.body.email + "'")`,
  "   res.json(rows)",
  " })",
  " module.exports = app",
  "",
].join("\n");

interface Posted {
  statuses: Array<{ repo: string; sha: string; state: string; context: string; description: string; target_url?: string }>;
  reviews: Array<{ repo: string; number: number; body: string; comments: Array<{ path: string; new_position: number; body: string }> }>;
  comments: Array<{ repo: string; number: number; body: string }>;
  hooks: Array<{ target: string; url: string; secret: string; events: string[] }>;
}
const posted: Posted = { statuses: [], reviews: [], comments: [], hooks: [] };
const people: Record<string, { id: number; login: string; owner: boolean; repos: Array<{ id: number; permissions: { admin: boolean; push: boolean; pull: boolean } }> }> = {
  "alice-token": { id: 501, login: "alice", owner: true, repos: [{ id: 11, permissions: { admin: true, push: true, pull: true } }, { id: 12, permissions: { admin: false, push: true, pull: true } }, { id: 99, permissions: { admin: true, push: true, pull: true } }] },
  "bob-token": { id: 502, login: "bob", owner: false, repos: [{ id: 11, permissions: { admin: false, push: false, pull: true } }, { id: 12, permissions: { admin: false, push: true, pull: true } }] },
};
/** Collaborators' permissions on every repo. */
const permissions: Record<string, string> = { dev: "write", maintainer: "write", outsider: "read" };

const fakeFetch = (async (input: string, init: RequestInit = {}) => {
  const url = new URL(input);
  const path = url.pathname.replace("/api/v1", "");
  const method = init.method ?? "GET";
  const body = init.body ? JSON.parse(init.body as string) : undefined;
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const token = (init.headers as Record<string, string>).authorization?.replace(/^Bearer /, "");
  // People, with their own tokens: who they are, what they can reach, and whether they run acme.
  const person = people[token ?? ""];
  if (person) {
    if (path === "/user") return json({ id: person.id, login: person.login });
    if (path === "/user/repos") return json(person.repos);
    if (path === `/users/${person.login}/orgs/acme/permissions`) return json({ is_owner: person.owner, is_admin: false, can_write: true, can_read: true });
    return json({ message: "Not Found" }, 404);
  }
  if (token !== "bot-token") return json({ message: "unauthorized" }, 401);

  if (path === "/orgs/acme") return json({ id: owner.id, name: "acme", username: "acme" });
  if (path === "/orgs/acme/repos") return json(repos);
  let match = /^\/repos\/(acme\/[\w-]+)$/.exec(path);
  if (match) return json(repos.find((r) => r.full_name === match![1]) ?? { message: "Not Found" }, repos.some((r) => r.full_name === match![1]) ? 200 : 404);
  if (path === "/orgs/acme/hooks" && method === "GET") return json(posted.hooks.filter((h) => h.target === "acme").map((h, i) => ({ id: i + 1, type: "gitea", active: true, config: { url: h.url } })));
  if (path === "/orgs/acme/hooks" && method === "POST") {
    posted.hooks.push({ target: "acme", url: body.config.url, secret: body.config.secret, events: body.events });
    return json({ id: posted.hooks.length }, 201);
  }
  match = /^\/repos\/(acme\/[\w-]+)\/pulls\/(\d+)\.diff$/.exec(path);
  if (match) return new Response(DIFF);
  match = /^\/repos\/(acme\/[\w-]+)\/pulls\/(\d+)$/.exec(path);
  if (match) return json({ number: Number(match[2]), head: { sha: "HEAD", repo_id: 11 }, base: { sha: "base", ref: "main" }, user: { login: "dev" } });
  match = /^\/repos\/(acme\/[\w-]+)\/compare\/.+$/.exec(path);
  if (match) return json({ files: [{ filename: "app.js", status: "modified" }] });
  match = /^\/repos\/(acme\/[\w-]+)\/statuses\/(\w+)$/.exec(path);
  if (match && method === "POST") {
    posted.statuses.push({ repo: match[1]!, sha: match[2]!, ...body });
    return json({ id: posted.statuses.length }, 201);
  }
  match = /^\/repos\/(acme\/[\w-]+)\/pulls\/(\d+)\/reviews$/.exec(path);
  if (match && method === "POST") {
    posted.reviews.push({ repo: match[1]!, number: Number(match[2]), body: body.body, comments: body.comments });
    return json({ id: posted.reviews.length });
  }
  match = /^\/repos\/(acme\/[\w-]+)\/issues\/(\d+)\/comments$/.exec(path);
  if (match && method === "POST") {
    posted.comments.push({ repo: match[1]!, number: Number(match[2]), body: body.body });
    return json({ id: posted.comments.length }, 201);
  }
  match = /^\/repos\/(acme\/[\w-]+)\/collaborators\/([\w-]+)\/permission$/.exec(path);
  if (match) return permissions[match[2]!] ? json({ permission: permissions[match[2]!] }) : json({ message: "Not Found" }, 404);
  return json({ message: `fake: unexpected ${method} ${path}` }, 404);
}) as unknown as typeof fetch;

// ---- Fake model -----------------------------------------------------------

const threatModelJson = {
  summary: "A login API.",
  stack: ["express"],
  entryPoints: [],
  authModel: "None.",
  trustBoundaries: [],
  sensitiveAssets: ["users"],
  dangerousSinks: [],
  frameworkProtections: [],
  abuseSurfaces: [],
  subsystems: [{ name: "api", paths: ["app.js"], description: "Everything.", risk: "high" }],
};
const candidate = {
  title: "SQL injection in login via email",
  category: "sql_injection",
  severity: "high",
  entryPoint: { file: "app.js", line: 3, description: "POST /login, body.email" },
  path: [{ file: "app.js", line: 4, note: "email concatenated into the query" }],
  preconditions: { attacker: "unauthenticated", trigger: "POSTs a crafted email to the login form", details: "none" },
  proofOfConcept: "POST /login email=' OR '1'='1",
  impact: "Reads every user row.",
};
const writeUp = {
  title: "SQL injection in login",
  severity: "high",
  cwe: "CWE-89",
  impact: "Anyone can read every user.",
  preconditions: "Unauthenticated.",
  proofOfConcept: "POST /login email=' OR '1'='1",
  fixGuidance: "Bind the email as a parameter.",
  guarantees: ["Input never changes the query"],
  mustNotBreak: ["Valid logins"],
  regressionTest: "Send the payload and assert no rows leak.",
};

function reply(content: string, toolCalls: ToolCall[] = []): ChatResult {
  return {
    content,
    reasoning: "",
    toolCalls,
    finishReason: toolCalls.length ? "tool_calls" : "stop",
    usage: { inputTokens: 10, cachedTokens: 5, outputTokens: 2, reasoningTokens: 0 },
    message: { role: "assistant", content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
    retries: 0,
  };
}
const call = (name: string, args: unknown): ToolCall => ({ id: `c-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } });

const fakeLlm: LlmClient = {
  config: { baseUrl: "http://fake", apiKey: "k", model: "m" },
  async chat(request: ChatRequest) {
    const answered = request.messages.some((m) => m.role === "tool");
    if (request.responseFormat) return reply(JSON.stringify(request.role === "recon" ? threatModelJson : writeUp));
    if (request.role === "recon") return reply("Notes.");
    if (request.role === "hunt") return answered ? reply("Done.") : reply("", [call("report_finding", candidate)]);
    const fixed = request.messages.map((m) => m.content ?? "").join("\n").includes("email = $1");
    return reply("", [
      call("submit_verdict", {
        verdict: fixed ? "disproved" : "confirmed",
        confidence: "high",
        disproof: fixed ? [{ file: "app.js", line: 4, explanation: "The email is bound as a parameter." }] : [],
        severity: "high",
        reasoning: fixed ? "Parameterised now." : "Concatenated into SQL.",
      }),
    ]);
  },
};

// ---- Setup ----------------------------------------------------------------

const FORGEJO_ENV = {
  FORGEJO_URL: "http://forgejo.test",
  FORGEJO_TOKEN: "bot-token",
  FORGEJO_WEBHOOK_SECRET: SECRET,
  FORGEJO_OWNERS: "acme",
};
const started: string[] = [];

beforeAll(async () => {
  if (!available) return;
  try {
    admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${NAME}`);
  } catch {
    available = false;
    return;
  }
  const url = new URL(ADMIN_URL);
  url.pathname = `/${NAME}`;
  // No GitHub App at all: a deployment that uses only Forgejo.
  for (const name of ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET", "SANDCHEST_GIT_HOST"]) delete process.env[name];
  Object.assign(process.env, {
    DATABASE_URL: url.toString(),
    SANDCHEST_APP_URL: "https://sandchest.test",
    SANDCHEST_WORKSPACE: "local",
    SANDCHEST_INDEXER_BIN: INDEXER,
    ...FORGEJO_ENV,
    FORGEJO_GIT_URL: `file://${gitRoot}`,
  });
  resetConfig();
  database = createDb(url.toString(), { max: 5 });
  await migrate(database);
  setServices({ db: database, llm: fakeLlm, osv: undefined, pricing: undefined });
  setForgejoClient(new Forgejo(loadForgejoConfig()!, { fetch: fakeFetch, maxBackoffMs: 1 }));
  setAutumn(undefined);
  setScanStarter(async (id) => void started.push(id));
});

afterAll(async () => {
  setScanStarter(undefined);
  setForgejoClient(undefined);
  for (const name of [...Object.keys(FORGEJO_ENV), "FORGEJO_GIT_URL"]) delete process.env[name];
  resetConfig();
  rmSync(gitRoot, { recursive: true, force: true });
  if (!available || !admin) return;
  await database.$client.end();
  await admin.unsafe(`drop database if exists ${NAME} with (force)`);
  await admin.end();
});

async function runWorkflow(scanId: string): Promise<void> {
  expect((await beginScan(scanId)).state).toBe("running");
  await executeScan(scanId);
  await publishScan(scanId);
}

/** Delivers an event the way Forgejo does: signed, with Forgejo's (or only Gitea's) headers. */
async function deliver(event: string, id: string, payload: unknown, options: { secret?: string; gitea?: boolean } = {}) {
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", options.secret ?? SECRET).update(body).digest("hex");
  const headers: Record<string, string> = { "content-type": "application/json", "x-gitea-event": event, "x-gitea-delivery": id, "x-gitea-signature": signature };
  if (!options.gitea) Object.assign(headers, { "x-forgejo-event": event, "x-forgejo-delivery": id, "x-forgejo-signature": signature });
  const response = await POST(new Request("https://sandchest.test/api/forgejo/webhooks", { method: "POST", headers, body }));
  return { status: response.status, outcome: (await response.json()) as { status: string; detail?: string; scans?: string[] } };
}

const prEvent = (repo: (typeof repos)[number], head: string, extra: { number?: number; title?: string; fork?: boolean; author?: string } = {}) => ({
  action: "opened",
  number: extra.number ?? 5,
  repository: repo,
  sender: { id: 1, login: extra.author ?? "dev" },
  pull_request: {
    number: extra.number ?? 5,
    title: extra.title ?? "Change the query",
    user: { id: 1, login: extra.author ?? "dev" },
    head: { sha: head, ref: "feature", repo_id: extra.fork ? 999 : repo.id, repo: { id: extra.fork ? 999 : repo.id, full_name: repo.full_name } },
    base: { sha: "base", ref: "main", repo_id: repo.id },
  },
});

describe.skipIf(!available)("Forgejo, end to end", () => {
  let work = "";
  let head = "";

  test("sync: records the owner and its repos, adds the org webhook once, and recon builds a threat model", async () => {
    ({ work, head } = makeRepo("private-app", VULNERABLE));
    makeRepo("public-app", VULNERABLE);
    const result = await syncForgejo(forgejoDeps()!);
    expect(result).toEqual({ owners: 1, failed: 0, removed: 0 });
    expect(posted.hooks).toEqual([{ target: "acme", url: "https://sandchest.test/api/forgejo/webhooks", secret: SECRET, events: ["push", "pull_request", "issue_comment", "repository"] }]);
    expect(started).toHaveLength(2);
    for (const id of started.splice(0)) await runWorkflow(id);

    const repo = await repoByGithubId(database, 11, "forgejo");
    expect(repo).toMatchObject({ provider: "forgejo", fullName: "acme/private-app", org: { provider: "forgejo", githubLogin: "acme", installationId: 300 } });
    expect((await threatModel(database, repo!.id))?.threatModel).toMatchObject({ summary: "A login API." });
    // The same GitHub id belongs to nobody: the providers never mix.
    expect(await repoByGithubId(database, 11)).toBeUndefined();

    // A second sync adds nothing and starts nothing.
    await syncForgejo(forgejoDeps()!);
    expect(posted.hooks).toHaveLength(1);
    expect(started).toHaveLength(0);
  }, 60_000);

  test("PR: pending status, inline review on the diff, failing status and a summary comment", async () => {
    const { status, outcome } = await deliver("pull_request", "d-pr", prEvent(repos[0]!, head));
    expect(status).toBe(202);
    const [scanId] = outcome.scans!;
    await beginScan(scanId!);
    expect(posted.statuses.at(-1)).toMatchObject({ repo: "acme/private-app", sha: head, state: "pending", context: "Sandchest", description: "Scanning…" });
    expect(posted.statuses.at(-1)!.target_url).toStartWith(`https://sandchest.test/dashboard/scans/${scanId}`);
    await executeScan(scanId!);
    await publishScan(scanId!);

    const review = posted.reviews.at(-1)!;
    expect(review).toMatchObject({ repo: "acme/private-app", number: 5 });
    expect(review.comments).toHaveLength(1);
    expect(review.comments[0]).toMatchObject({ path: "app.js", new_position: 4 });
    expect(review.comments[0]!.body).toContain("Fix prompt for your coding agent");
    expect(posted.statuses.at(-1)).toMatchObject({ sha: head, state: "failure", context: "Sandchest", description: "Found 1 issue: 1 high" });
    expect(posted.comments.at(-1)).toMatchObject({ repo: "acme/private-app", number: 5 });
    expect(posted.comments.at(-1)!.body).toContain("**Sandchest: Found 1 issue: 1 high**");
    const scan = await scanById(database, scanId!);
    expect(scan?.status).toBe("completed");
    expect(await openFindings(database, scan!.repoId)).toHaveLength(1);
  }, 60_000);

  test("a redelivered webhook is ignored; Gitea's headers alone are enough", async () => {
    expect((await deliver("pull_request", "d-pr", prEvent(repos[0]!, head))).outcome.status).toBe("duplicate");
    const gitea = await deliver("pull_request", "d-gitea", { ...prEvent(repos[0]!, head), action: "synchronized" }, { gitea: true });
    expect(gitea.status).toBe(202);
    // The same head is not reviewed twice.
    expect(gitea.outcome).toMatchObject({ status: "handled", scans: [] });
  });

  test("a wrong signature is refused before anything is read", async () => {
    const { status } = await deliver("pull_request", "d-bad", prEvent(repos[0]!, "abc"), { secret: "not-the-secret" });
    expect(status).toBe(401);
  });

  test("push to the default branch: a fix check marks the finding fixed", async () => {
    const after = pushCommit("private-app", work, FIXED);
    const { outcome } = await deliver("push", "d-push", { ref: "refs/heads/main", before: head, after, repository: repos[0] });
    const fixCheck = outcome.scans!.at(-1)!;
    await runWorkflow(fixCheck);
    const scan = await scanById(database, fixCheck);
    expect(scan?.kind).toBe("fix_check");
    expect(await openFindings(database, scan!.repoId)).toHaveLength(0);
  }, 60_000);

  test("public repos get a redacted status and comment, and no review", async () => {
    const reviews = posted.reviews.length;
    const { outcome } = await deliver("pull_request", "d-pr-public", prEvent(repos[1]!, git(join(gitRoot, "acme", "public-app.git"), "rev-parse", "HEAD")));
    await runWorkflow(outcome.scans![0]!);
    expect(posted.reviews.length).toBe(reviews);
    expect(posted.statuses.at(-1)).toMatchObject({ repo: "acme/public-app", state: "failure" });
    const comment = posted.comments.at(-1)!;
    expect(comment).toMatchObject({ repo: "acme/public-app" });
    expect(comment.body).toContain("Sandchest found 1 high-severity issue.");
    expect(JSON.stringify(posted.statuses.at(-1)) + comment.body).not.toContain("app.js");
  }, 60_000);

  test("webhook rules: drafts, forks, other branches, uncovered repos and the review command", async () => {
    expect((await deliver("pull_request", "d-draft", prEvent(repos[0]!, "abc", { title: "WIP: not yet" }))).outcome.detail).toBe("draft");
    const draft = prEvent(repos[0]!, "abc");
    expect((await deliver("pull_request", "d-draft2", { ...draft, pull_request: { ...draft.pull_request, draft: true } })).outcome.detail).toBe("draft");
    expect((await deliver("pull_request", "d-closed", { ...prEvent(repos[0]!, "abc"), action: "closed" })).outcome.status).toBe("ignored");

    expect((await deliver("pull_request", "d-fork", prEvent(repos[1]!, "abc", { fork: true }))).outcome.detail).toContain("waiting for /sandchest review");
    expect((await deliver("pull_request", "d-fork-private", prEvent(repos[0]!, "abc", { fork: true, author: "outsider", number: 6 }))).outcome.detail).toBe("PR from an author without write access");
    expect((await deliver("pull_request", "d-fork-member", prEvent(repos[0]!, "abcd", { fork: true, author: "maintainer", number: 7 }))).outcome.scans).toHaveLength(1);
    // AGit (`git push origin HEAD:refs/for/main/topic`) needs only read access, and its head is the base repository itself.
    expect((await deliver("pull_request", "d-agit-public", prEvent(repos[1]!, "abc", { author: "outsider", number: 8 }))).outcome.detail).toContain("waiting for /sandchest review");
    expect((await deliver("pull_request", "d-agit-private", prEvent(repos[0]!, "abc", { author: "outsider", number: 9 }))).outcome.detail).toBe("PR from an author without write access");
    expect((await deliver("pull_request", "d-agit-member", prEvent(repos[1]!, "abcde", { author: "maintainer", number: 10 }))).outcome.scans).toHaveLength(1);

    expect((await deliver("push", "d-branch", { ref: "refs/heads/feature", before: "a", after: "b", repository: repos[0] })).outcome.detail).toBe("not the default branch");
    const stranger = { id: 77, full_name: "someone/else", private: true, default_branch: "main", owner: { id: 5, login: "someone" } };
    expect((await deliver("pull_request", "d-stranger", prEvent(stranger, "abc"))).outcome.detail).toBe("repo not enabled");

    const command = (body: string, id: string, login = "maintainer") =>
      deliver("issue_comment", id, { action: "created", is_pull: true, repository: repos[1], issue: { number: 5, pull_request: {} }, comment: { body, user: { id: 2, login } }, sender: { id: 2, login } });
    expect((await command("looks good", "d-c1")).outcome.status).toBe("ignored");
    expect((await command("/sandchest review", "d-c2", "outsider")).outcome.detail).toBe("commenter lacks write access");
    const reviewed = await command("/sandchest review", "d-c3");
    expect(reviewed.outcome.status).toBe("handled");
    expect(reviewed.outcome.scans).toHaveLength(1);
  });

  test("people signed in with Forgejo see the repos they can push to, and admins the owner's settings", async () => {
    const [alice, bob] = await database
      .insert(schema.users)
      .values([
        { name: "Alice", email: "alice@example.com" },
        { name: "Bob", email: "bob@example.com" },
      ])
      .returning();
    const forgejo = forgejoDeps()!.forgejo;
    await storeForgejoAccess(alice!.id, forgejo.asUser("alice-token"));
    await storeForgejoAccess(bob!.id, forgejo.asUser("bob-token"));

    // Repo 99 is not covered, so it never shows.
    expect((await dashboardRepos(database, alice!.id)).map((r) => r.fullName).sort()).toEqual(["acme/private-app", "acme/public-app"]);
    expect((await dashboardRepos(database, bob!.id)).map((r) => r.fullName)).toEqual(["acme/public-app"]);
    expect((await settingsOrgs(database, alice!.id)).map((o) => [o.login, o.admin])).toEqual([["acme", true]]);
    expect((await settingsOrgs(database, bob!.id)).map((o) => [o.login, o.admin])).toEqual([["acme", false]]);
    // A Forgejo login is kept; no GitHub identity is claimed.
    expect(await database.query.users.findFirst({ where: (users, { eq }) => eq(users.id, alice!.id) })).toMatchObject({ login: "alice", githubUserId: null });
  });

  test("the sweep leaves a failed recon alone, and starts one for a repository that comes back", async () => {
    started.splice(0);
    const repo = (await repoByGithubId(database, 12, "forgejo"))!;
    await database.$client`delete from repo_memory where repo_id = ${repo.id}`;
    await database.$client`update scans set status = 'failed' where repo_id = ${repo.id} and kind = 'recon'`;
    await syncForgejo(forgejoDeps()!);
    expect(started).toHaveLength(0);

    await deliver("repository", "d-repo-gone", { action: "deleted", repository: repos[1] });
    await syncForgejo(forgejoDeps()!);
    expect((await repoByGithubId(database, 12, "forgejo"))?.enabled).toBe(true);
    expect(started).toHaveLength(1);
    expect((await scanById(database, started.splice(0)[0]!))).toMatchObject({ repoId: repo.id, kind: "recon" });
  });

  test("a listed repository that is gone or archived leaves the owner's others to sync", async () => {
    const deps = forgejoDeps()!;
    const owners = ["private-app", "gone", "old-app"].map((repo) => ({ owner: "acme", repo }));
    const result = await syncForgejo({ ...deps, forgejo: new Forgejo({ ...deps.forgejo.config, owners }, { fetch: fakeFetch, maxBackoffMs: 1 }) });
    expect(result.failed).toBe(0);
    expect((await repoByGithubId(database, 11, "forgejo"))?.enabled).toBe(true);
    expect(await repoByGithubId(database, 13, "forgejo")).toBeUndefined();
    // No longer listed, so disabled.
    expect((await repoByGithubId(database, 12, "forgejo"))?.enabled).toBe(false);
  });

  test("a deleted repository is disabled, and an owner taken off FORGEJO_OWNERS is forgotten", async () => {
    await deliver("repository", "d-repo-deleted", { action: "deleted", repository: repos[1] });
    expect((await repoByGithubId(database, 12, "forgejo"))?.enabled).toBe(false);

    const deps = forgejoDeps()!;
    const result = await syncForgejo({ ...deps, forgejo: new Forgejo({ ...deps.forgejo.config, owners: [] }, { fetch: fakeFetch, maxBackoffMs: 1 }) });
    expect(result.removed).toBe(1);
    expect((await repoByGithubId(database, 11, "forgejo"))?.org.installationId).toBeNull();
  });
});
