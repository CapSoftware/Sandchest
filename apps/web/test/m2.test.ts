/**
 * The GitHub App path end to end, in-process: webhooks → scan workflow steps
 * → engine → database → Checks and review comments. Real: Postgres (local
 * docker), git, the workspace, the indexer and the engine. Fake: GitHub's
 * API and the model. Skips without a local Postgres or an indexer build.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import postgres from "postgres";
import { createDb, openFindings, scanById, threatModel, type Db } from "@sandchest/db";
import { migrate } from "@sandchest/db/migrate";
import type { ChatRequest, ChatResult, LlmClient, ToolCall } from "@sandchest/engine/llm";
import type { GitHubApp } from "@sandchest/github";
import { beginScan, executeScan, publishScan } from "@/server/scans";
import { setServices } from "@/server/services";
import { handleWebhook } from "@/server/webhooks";

const INDEXER = resolve(import.meta.dirname, "../../../target/release/sandchest-index");
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest";
const NAME = `sandchest_web_test_${process.pid}`;

let admin: postgres.Sql | undefined;
let database: Db;
let available = existsSync(INDEXER);
const gitRoot = mkdtempSync(join(tmpdir(), "sandchest-git-"));

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

/** A repository at `<gitRoot>/acme/<name>.git` with one commit holding `content`. Returns its head. */
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

// ---- Fake GitHub ----------------------------------------------------------

interface Recorded {
  checks: Array<{ repo: string; headSha: string; title: string }>;
  completed: Array<{ repo: string; conclusion: string; title: string; summary: string }>;
  reviews: Array<{ repo: string; number: number; body: string; comments: Array<{ path: string; line: number; body: string }> }>;
}
const recorded: Recorded = { checks: [], completed: [], reviews: [] };
const repos = [
  { id: 1, full_name: "acme/private-app", private: true, default_branch: "main" },
  { id: 2, full_name: "acme/public-app", private: false, default_branch: "main" },
];
const patch = "@@ -1,7 +1,7 @@\n const express = require(\"express\")\n const app = express()\n app.post(\"/login\", async (req, res) => {\n-  const rows = await db.query(\"SELECT 1\")\n+  const rows = await db.query(\"SELECT * FROM users WHERE email = '\" + req.body.email + \"'\")\n   res.json(rows)\n })\n module.exports = app";

const fakeGithub = {
  installation: () => ({
    repositories: async () => repos,
    cloneToken: async () => "token",
    pullFiles: async () => [{ filename: "app.js", status: "modified", additions: 1, deletions: 1, patch }],
    compare: async () => [{ filename: "app.js", status: "modified", additions: 1, deletions: 1 }],
    createCheckRun: async (repo: string, input: { headSha: string; output: { title: string } }) => {
      recorded.checks.push({ repo, headSha: input.headSha, title: input.output.title });
      return recorded.checks.length;
    },
    completeCheckRun: async (repo: string, _id: number, conclusion: string, output: { title: string; summary: string }) => {
      recorded.completed.push({ repo, conclusion, ...output });
    },
    createReview: async (repo: string, number: number, input: { body: string; comments: Array<{ path: string; line: number; body: string }> }) => {
      recorded.reviews.push({ repo, number, ...input });
    },
    permission: async () => "write",
    pull: async () => ({ number: 5, head: { sha: "x" }, base: { sha: "y" } }),
    branchSha: async () => "HEAD",
  }),
} as unknown as GitHubApp;

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
  preconditions: { attacker: "unauthenticated", details: "none" },
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
    // The skeptic disproves once the query binds its parameter.
    const text = request.messages.map((m) => m.content ?? "").join("\n");
    const fixed = text.includes("email = $1");
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
  Object.assign(process.env, {
    DATABASE_URL: url.toString(),
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: "unused",
    GITHUB_WEBHOOK_SECRET: "unused",
    SANDCHEST_APP_URL: "https://sandchest.test",
    SANDCHEST_WORKSPACE: "local",
    SANDCHEST_INDEXER_BIN: INDEXER,
    SANDCHEST_GIT_HOST: `file://${gitRoot}`,
  });
  database = createDb(url.toString(), { max: 5 });
  await migrate(database);
  setServices({ db: database, github: fakeGithub, llm: fakeLlm, osv: undefined, pricing: undefined });
});

afterAll(async () => {
  rmSync(gitRoot, { recursive: true, force: true });
  if (!available || !admin) return;
  await database.$client.end();
  await admin.unsafe(`drop database if exists ${NAME} with (force)`);
  await admin.end();
});

const started: string[] = [];
const deps = () => ({ db: database, github: fakeGithub, startScan: async (id: string) => void started.push(id) });

/** What the workflow does, step by step. */
async function runWorkflow(scanId: string): Promise<void> {
  expect((await beginScan(scanId)).state).toBe("running");
  await executeScan(scanId);
  await publishScan(scanId);
}

const installation = { installation: { id: 77, account: { id: 900, login: "acme", type: "Organization" } } };
const prEvent = (repo: (typeof repos)[number], head: string) => ({
  action: "opened",
  number: 5,
  installation: { id: 77 },
  repository: repo,
  sender: { login: "dev" },
  pull_request: { number: 5, draft: false, head: { sha: head, ref: "feature", repo: { id: repo.id, full_name: repo.full_name } }, base: { sha: "base", ref: "main", repo: { id: repo.id } }, author_association: "MEMBER" },
});

describe.skipIf(!available)("GitHub App, end to end", () => {
  let work = "";
  let head = "";

  test("install: records the org and repos, and recon builds a threat model", async () => {
    ({ work, head } = makeRepo("private-app", VULNERABLE));
    makeRepo("public-app", VULNERABLE);
    const outcome = await handleWebhook(deps(), "installation", "d-install", { action: "created", ...installation });
    expect(outcome.status).toBe("handled");
    expect(outcome.scans).toHaveLength(2);
    for (const id of outcome.scans!) await runWorkflow(id);
    const scan = await scanById(database, outcome.scans![0]!);
    expect(scan?.status).toBe("completed");
    expect((await threatModel(database, scan!.repoId))?.threatModel).toMatchObject({ summary: "A login API." });
  }, 60_000);

  test("PR: in-progress Check, inline comment on the diff, failing Check", async () => {
    const outcome = await handleWebhook(deps(), "pull_request", "d-pr", prEvent(repos[0]!, head));
    const [scanId] = outcome.scans!;
    await beginScan(scanId!);
    expect(recorded.checks.at(-1)).toEqual({ repo: "acme/private-app", headSha: head, title: "Digging…" });
    await executeScan(scanId!);
    await publishScan(scanId!);

    const review = recorded.reviews.at(-1)!;
    expect(review.comments).toHaveLength(1);
    expect(review.comments[0]).toMatchObject({ path: "app.js", line: 4 });
    expect(review.comments[0]!.body).toContain("Fix prompt for your coding agent");
    expect(recorded.completed.at(-1)).toMatchObject({ repo: "acme/private-app", conclusion: "failure" });
    const scan = await scanById(database, scanId!);
    expect(scan).toMatchObject({ status: "completed", credits: 1 });
    expect(await openFindings(database, scan!.repoId)).toHaveLength(1);
  }, 60_000);

  test("a redelivered webhook is ignored", async () => {
    expect((await handleWebhook(deps(), "pull_request", "d-pr", prEvent(repos[0]!, head))).status).toBe("duplicate");
  });

  test("push to the default branch: a fix check marks the finding fixed", async () => {
    const after = pushCommit("private-app", work, FIXED);
    const outcome = await handleWebhook(deps(), "push", "d-push", { ref: "refs/heads/main", before: head, after, installation: { id: 77 }, repository: repos[0] });
    const fixCheck = outcome.scans!.at(-1)!;
    await runWorkflow(fixCheck);
    const scan = await scanById(database, fixCheck);
    expect(scan?.kind).toBe("fix_check");
    expect(await openFindings(database, scan!.repoId)).toHaveLength(0);
  }, 60_000);

  test("public repos get a redacted Check and no review", async () => {
    const reviews = recorded.reviews.length;
    const outcome = await handleWebhook(deps(), "pull_request", "d-pr-public", prEvent(repos[1]!, git(join(gitRoot, "acme", "public-app.git"), "rev-parse", "HEAD")));
    await runWorkflow(outcome.scans![0]!);
    expect(recorded.reviews.length).toBe(reviews);
    const check = recorded.completed.at(-1)!;
    expect(check.conclusion).toBe("failure");
    expect(check.summary).toContain("Sandchest found 1 high-severity issue.");
    expect(JSON.stringify(check)).not.toContain("app.js");
  }, 60_000);

  test("webhook rules: drafts, public forks, other branches and the review command", async () => {
    const draft = prEvent(repos[0]!, "abc");
    draft.pull_request.draft = true;
    expect((await handleWebhook(deps(), "pull_request", "d-draft", draft)).detail).toBe("draft");

    const fork = prEvent(repos[1]!, "abc");
    fork.pull_request.head.repo = { id: 999, full_name: "stranger/public-app" };
    expect((await handleWebhook(deps(), "pull_request", "d-fork", fork)).detail).toContain("waiting for /sandchest review");

    const otherBranch = { ref: "refs/heads/feature", before: "a", after: "b", installation: { id: 77 }, repository: repos[0] };
    expect((await handleWebhook(deps(), "push", "d-branch", otherBranch)).detail).toBe("not the default branch");

    const command = (body: string, id: string) =>
      handleWebhook(deps(), "issue_comment", id, {
        action: "created",
        installation: { id: 77 },
        repository: repos[1],
        issue: { number: 5, pull_request: { url: "x" } },
        comment: { body, user: { login: "maintainer", type: "User" } },
        sender: { login: "maintainer", type: "User" },
      });
    expect((await command("looks good", "d-c1")).status).toBe("ignored");
    const reviewed = await command("/sandchest review", "d-c2");
    expect(reviewed.status).toBe("handled");
    expect(reviewed.scans).toHaveLength(1);
  });
});
