/**
 * Stand-ins for GitHub's API and the model endpoint, for the self-hosting
 * end-to-end test (docker/test/e2e.sh). No dependencies; runs on Node.
 *
 * GitHub: the manifest conversion (one code, usable once), installation
 * tokens (only for a JWT signed with the App's key), the installation's
 * repositories, a branch's head, and a pull request's files, Check runs and
 * review. The model: just enough of the
 * chat-completions stream to take one scan from recon to a finding.
 *
 * POST /control?delayMs=N slows the model down; GET /stats counts calls; GET /posted
 * returns the check runs and reviews the App posted.
 *
 * Env: FAKE_PEM_FILE (the App's private key), FAKE_HEAD_SHA (the test repo's
 * main branch), FAKE_PORT (default 4010).
 */
import { createPublicKey, createVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";

const PORT = Number(process.env.FAKE_PORT || 4010);
const PEM = readFileSync(process.env.FAKE_PEM_FILE, "utf8");
const PUBLIC_KEY = createPublicKey(PEM);
const APP_ID = 424242;
const CODE = "e2e-code";

const stats = { conversions: 0, conversionsRefused: 0, tokens: 0, tokensRefused: 0, chats: 0, roles: {} };
let codeUsed = false;
/** Check runs and reviews the App posted, for the test to read back. */
const checks = [];
const reviews = [];
const PR_PATCH =
  '@@ -1,7 +1,7 @@\n const express = require("express")\n const app = express()\n app.post("/login", async (req, res) => {\n-  const rows = await db.query("SELECT 1")\n+  const rows = await db.query("SELECT * FROM users WHERE email = \'" + req.body.email + "\'")\n   res.json(rows)\n })\n module.exports = app';
/** How long the model takes to answer; the test slows it down to restart the server mid-scan. */
let delayMs = 0;

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

/** A valid RS256 App JWT for this App, unexpired. */
function appJwtValid(header) {
  const token = header?.replace(/^Bearer /, "") ?? "";
  const [head, body, signature] = token.split(".");
  if (!head || !body || !signature) return false;
  const verified = createVerify("RSA-SHA256").update(`${head}.${body}`).verify(PUBLIC_KEY, Buffer.from(signature, "base64url"));
  const claims = JSON.parse(Buffer.from(body, "base64url").toString());
  return verified && String(claims.iss) === String(APP_ID) && claims.exp * 1000 > Date.now();
}

// ---- The model ------------------------------------------------------------

const VULNERABLE_LINE = 4;
const threatModel = {
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
  path: [{ file: "app.js", line: VULNERABLE_LINE, note: "email concatenated into the query" }],
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
const verdict = { verdict: "confirmed", confidence: "high", disproof: [], severity: "high", reasoning: "Concatenated into SQL." };

/** What the engine asked for, read from the request: structured output by schema name, tool loops by their tools. */
function answer(request) {
  const schema = request.response_format?.json_schema?.name;
  if (schema === "threat_model") return { role: "recon", content: JSON.stringify(threatModel) };
  if (schema) return { role: `structure:${schema}`, content: JSON.stringify(writeUp) };
  const tools = new Set((request.tools ?? []).map((t) => t.function?.name));
  const answered = (request.messages ?? []).some((m) => m.role === "tool");
  if (tools.has("report_finding")) return answered ? { role: "hunt", content: "Done." } : { role: "hunt", call: ["report_finding", candidate] };
  if (tools.has("submit_verdict")) return { role: "skeptic", call: ["submit_verdict", verdict] };
  return { role: "notes", content: "Notes." };
}

function stream(response, reply) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  const send = (chunk) => response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  if (reply.call) {
    send({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${reply.call[0]}`, function: { name: reply.call[0], arguments: JSON.stringify(reply.call[1]) } }] }, finish_reason: "tool_calls" }] });
  } else {
    send({ choices: [{ delta: { content: reply.content }, finish_reason: "stop" }] });
  }
  send({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 5 } } });
  response.end("data: [DONE]\n\n");
}

// ---- Server ---------------------------------------------------------------

http
  .createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const url = new URL(request.url, "http://fakes");
      const path = url.pathname;

      if (request.method === "POST" && path === "/v1/chat/completions") {
        const reply = answer(JSON.parse(raw));
        stats.chats++;
        stats.roles[reply.role] = (stats.roles[reply.role] ?? 0) + 1;
        setTimeout(() => stream(response, reply), delayMs);
        return;
      }
      if (request.method === "GET" && path === "/stats") return json(response, 200, stats);
      if (request.method === "GET" && path === "/posted") return json(response, 200, { checks, reviews });
      if (request.method === "POST" && path === "/control") {
        delayMs = Number(url.searchParams.get("delayMs") ?? 0);
        return json(response, 200, { delayMs });
      }

      const conversion = path.match(/^\/app-manifests\/([^/]+)\/conversions$/);
      if (request.method === "POST" && conversion) {
        if (conversion[1] !== CODE || codeUsed) {
          stats.conversionsRefused++;
          return json(response, 404, { message: "Not Found" });
        }
        codeUsed = true;
        stats.conversions++;
        return json(response, 201, {
          id: APP_ID,
          slug: "sandchest-e2e",
          name: "Sandchest e2e",
          owner: { login: "acme", type: "Organization" },
          html_url: "https://github.com/apps/sandchest-e2e",
          client_id: "Iv23liE2eClient",
          client_secret: "e2e0client0secret0000000000000000000000",
          webhook_secret: "e2e0webhook0secret000000000000000000000",
          pem: PEM,
        });
      }

      // Everything else is the App acting as itself or as an installation.
      if (request.method === "POST" && path === "/app/installations/77/access_tokens") {
        if (!appJwtValid(request.headers.authorization)) {
          stats.tokensRefused++;
          return json(response, 401, { message: "A JSON web token could not be decoded" });
        }
        stats.tokens++;
        return json(response, 201, { token: "ghs_e2e", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      }
      if (request.headers.authorization !== "Bearer ghs_e2e") return json(response, 401, { message: "Bad credentials" });
      if (request.method === "GET" && path === "/installation/repositories") {
        return json(response, 200, { total_count: 1, repositories: [{ id: 1001, full_name: "acme/app", private: true, default_branch: "main" }] });
      }
      if (request.method === "GET" && path === "/repos/acme/app/branches/main") return json(response, 200, { commit: { sha: process.env.FAKE_HEAD_SHA } });

      // Pull request 5 adds the vulnerable query on line 4.
      if (request.method === "GET" && path === "/repos/acme/app/pulls/5/files") {
        return json(response, 200, [{ filename: "app.js", status: "modified", additions: 1, deletions: 1, patch: PR_PATCH }]);
      }
      if (request.method === "POST" && path === "/repos/acme/app/check-runs") {
        const body = JSON.parse(raw);
        checks.push({ id: checks.length + 1, headSha: body.head_sha, createdAs: body.status, firstTitle: body.output?.title, detailsUrl: body.details_url });
        return json(response, 201, { id: checks.length });
      }
      const checkRun = path.match(/^\/repos\/acme\/app\/check-runs\/(\d+)$/);
      if (request.method === "PATCH" && checkRun) {
        const body = JSON.parse(raw);
        const check = checks[Number(checkRun[1]) - 1];
        if (!check) return json(response, 404, { message: "Not Found" });
        Object.assign(check, { status: body.status, conclusion: body.conclusion, title: body.output?.title });
        return json(response, 200, { id: check.id });
      }
      if (request.method === "POST" && path === "/repos/acme/app/pulls/5/reviews") {
        const body = JSON.parse(raw);
        reviews.push({ commitId: body.commit_id, event: body.event, comments: (body.comments ?? []).map((c) => ({ path: c.path, line: c.line, side: c.side })) });
        return json(response, 200, { id: reviews.length });
      }

      console.log(`fakes: unexpected ${request.method} ${path}`);
      return json(response, 404, { message: "Not Found" });
    });
  })
  .listen(PORT, "0.0.0.0", () => console.log(`fakes listening on ${PORT}`));
