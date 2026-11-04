/**
 * Agents end to end against a real Postgres (local docker), with GitHub and
 * Autumn faked: connecting by device flow and by OAuth (PKCE, rotating
 * refresh tokens), the REST API and the MCP server over the same operations,
 * access scoping, billing and deep scans. Skips without Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";
import { createDb, decideDeviceGrant, schema, upsertFindings, upsertInstallation, type Db, type FindingInput } from "@sandchest/db";
import { migrate } from "@sandchest/db/migrate";
import type { GitHubApp } from "@sandchest/github";
import { POST as mcpPost } from "@/app/api/mcp/route";
import { POST as tokenPost } from "@/app/api/oauth/token/route";
import { POST as registerPost } from "@/app/api/oauth/register/route";
import { POST as revokePost } from "@/app/api/oauth/revoke/route";
import { POST as devicePost } from "@/app/api/v1/auth/device/route";
import { GET as openApiGet } from "@/app/api/v1/openapi.json/route";
import { storeAccess } from "@/server/access";
import { checkAuthorize, issueCode, allowedRedirect } from "@/server/agent/oauth";
import { handleRest, matchPath } from "@/server/agent/rest";
import { OPERATIONS } from "@/server/agent/registry";
import { setAutumn } from "@/server/billing";
import { resetConfig } from "@/server/config";
import { setServices } from "@/server/services";
import { setScanStarter } from "@/server/start";
import { FakeAutumn } from "./fake-autumn";

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest";
const NAME = `sandchest_agents_test_${process.pid}`;
const BASE = "https://sandchest.test";

let admin: postgres.Sql | undefined;
let database: Db;
let available = true;
const autumn = new FakeAutumn();
const started: string[] = [];
let ids: { acme: string; api: string; secret: string; alice: string; bob: string; findings: string[]; secretFinding: string };

function fakeGithub(user: { id: number; login: string }, installations: Array<{ id: number; account: { id: number; login: string; type: "User" | "Organization" }; repos: Array<{ id: number; push?: boolean; admin?: boolean }>; orgAdmin?: boolean }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/user") return json(user);
    if (url.pathname === "/user/installations") return json({ installations: installations.map(({ id, account }) => ({ id, account, suspended_at: null })) });
    const repos = /^\/user\/installations\/(\d+)\/repositories$/.exec(url.pathname);
    if (repos) return json({ repositories: installations.find((i) => i.id === Number(repos[1]))!.repos.map((r) => ({ id: r.id, permissions: { admin: !!r.admin, push: !!r.push || !!r.admin, pull: true } })) });
    const membership = /^\/user\/memberships\/orgs\/(.+)$/.exec(url.pathname);
    if (membership) return installations.find((i) => i.account.login === decodeURIComponent(membership[1]!))?.orgAdmin ? json({ state: "active", role: "admin" }) : json({ message: "Not Found" }, 404);
    return json({ message: `unexpected ${url.pathname}` }, 500);
  }) as typeof fetch;
}

function finding(fingerprint: string, severity: FindingInput["severity"], confidence: FindingInput["confidence"] = "high"): FindingInput {
  return {
    fingerprint,
    severity,
    confidence,
    category: "broken_access_control",
    cwe: "CWE-639",
    title: `Finding ${fingerprint}`,
    impact: "Reads other customers' invoices.",
    entryPoint: { file: "a.ts", line: 1, description: "GET /x" },
    attackPath: [{ file: "a.ts", line: 2, note: "sink", excerpt: "1| a\n2| b\n3| c" }],
    attacker: "any_user",
    preconditions: "Any user",
    proofOfConcept: "curl /x",
    fixGuidance: "Scope it.",
    guarantees: ["Scoped"],
    mustNotBreak: [],
    regressionTest: "Request another org's invoice.",
    fixPrompt: "Fix the unscoped lookup at a.ts:2",
  };
}

beforeAll(async () => {
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
    SANDCHEST_APP_URL: BASE,
    GITHUB_APP_SLUG: "sandchest-test",
  });
  resetConfig();
  database = createDb(url.toString(), { max: 5 });
  await migrate(database);
  const github = { installation: () => ({ branchSha: async () => "sha1", repositories: async () => [] }) } as unknown as GitHubApp;
  setServices({ db: database, github });
  setAutumn(autumn);
  setScanStarter(async (id) => void started.push(id));

  const acme = await upsertInstallation(database, 11, { githubAccountId: 100, githubLogin: "acme", type: "Organization" }, [
    { githubRepoId: 1, fullName: "acme/api", private: true, defaultBranch: "main" },
    { githubRepoId: 3, fullName: "acme/secret", private: true, defaultBranch: "main" },
  ]);
  const [alice] = await database.insert(schema.users).values({ name: "Alice", email: "alice@example.com", login: "alice" }).returning();
  const [bob] = await database.insert(schema.users).values({ name: "Bob", email: "bob@example.com", login: "bob" }).returning();
  const [scan] = await database.insert(schema.scans).values({ repoId: acme.repos[0]!.id, orgId: acme.org.id, kind: "deep", status: "completed", trigger: "manual", headSha: "abc" }).returning();
  const { ids: findingIds } = await upsertFindings(database, acme.repos[0]!.id, scan!, [finding("f1", "critical"), finding("f2", "high"), finding("f3", "medium"), finding("f4", "low", "low")]);
  const { ids: secretIds } = await upsertFindings(database, acme.repos[1]!.id, scan!, [finding("s1", "critical")]);
  ids = { acme: acme.org.id, api: acme.repos[0]!.id, secret: acme.repos[1]!.id, alice: alice!.id, bob: bob!.id, findings: findingIds, secretFinding: secretIds[0]! };

  // Alice administers acme and can push to both repos; Bob can push to acme/api only.
  await storeAccess(ids.alice, "a", { fetch: fakeGithub({ id: 501, login: "alice" }, [{ id: 11, account: { id: 100, login: "acme", type: "Organization" }, repos: [{ id: 1, admin: true }, { id: 3, push: true }], orgAdmin: true }]) });
  await storeAccess(ids.bob, "b", { fetch: fakeGithub({ id: 502, login: "bob" }, [{ id: 11, account: { id: 100, login: "acme", type: "Organization" }, repos: [{ id: 1, push: true }] }]) });
});

afterAll(async () => {
  setAutumn(undefined);
  setScanStarter(undefined);
  if (!available) return;
  await database.$client.end();
  await admin!.unsafe(`drop database if exists ${NAME} with (force)`);
  await admin!.end();
});

const post = (body: unknown, form = false) =>
  new Request(`${BASE}/x`, {
    method: "POST",
    headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" },
    body: form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body),
  });

/** Calls the REST API the way an agent would. */
async function api(key: string | null, method: string, path: string, body?: unknown) {
  const url = new URL(`${BASE}/api/v1${path}`);
  const request = new Request(url, {
    method,
    headers: { ...(key && { authorization: `Bearer ${key}` }), ...(body !== undefined && { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const segments = url.pathname.replace(/^\/api\/v1\/?/, "").split("/").filter(Boolean);
  const response = await handleRest(request, segments);
  return { status: response.status, headers: response.headers, body: (await response.json()) as Record<string, any> };
}

async function mcp(key: string | null, method: string, params?: unknown, id: number | null = 1) {
  const response = await mcpPost(
    new Request(`${BASE}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key && { authorization: `Bearer ${key}` }) },
      body: JSON.stringify({ jsonrpc: "2.0", ...(id !== null && { id }), method, ...(params !== undefined && { params }) }),
    }),
  );
  return { status: response.status, headers: response.headers, body: response.status === 202 ? null : ((await response.json()) as Record<string, any>) };
}

/** Connects a person with the device flow, as an agent would, approving for them in the database. */
async function connectByDevice(userId: string, name = "Test agent"): Promise<string> {
  const start = (await (await devicePost(post({ client_name: name }))).json()) as Record<string, any>;
  await decideDeviceGrant(database, start.user_code.replace("-", ""), userId, true);
  const issued = (await (await tokenPost(post({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: start.device_code }, true))).json()) as Record<string, any>;
  return issued.access_token;
}

let aliceKey: string;
let bobKey: string;

describe.skipIf(!available)("connecting", () => {
  test("device flow: pending, slow down, approved once, then the code is spent", async () => {
    const response = await devicePost(post({ client_name: "Claude Code" }));
    expect(response.status).toBe(200);
    const start = (await response.json()) as Record<string, any>;
    expect(start.user_code).toMatch(/^[B-Z]{4}-[B-Z]{4}$/);
    expect(start.verification_uri_complete).toBe(`${BASE}/device?code=${start.user_code.replace("-", "")}`);
    expect(start.interval).toBe(5);

    const poll = async () => (await tokenPost(post({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: start.device_code }, true))).json() as Promise<Record<string, any>>;
    expect((await poll()).error).toBe("authorization_pending");
    expect((await poll()).error).toBe("slow_down");

    expect(await decideDeviceGrant(database, start.user_code.replace("-", ""), ids.alice, true)).toBe(true);
    // A second decision on the same code changes nothing.
    expect(await decideDeviceGrant(database, start.user_code.replace("-", ""), ids.bob, true)).toBe(false);
    const issued = await poll();
    expect(issued.access_token).toMatch(/^sck_/);
    expect(issued.token_type).toBe("Bearer");
    expect((await poll()).error).toBe("invalid_grant");
    aliceKey = issued.access_token;
    bobKey = await connectByDevice(ids.bob);

    // Only the hash is stored.
    const rows = await database.select().from(schema.apiTokens);
    expect(rows.some((row) => row.tokenHash === createHash("sha256").update(aliceKey).digest("hex"))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(aliceKey);
  });

  test("device flow with wait: one call holds until the person approves", async () => {
    const start = (await (await devicePost(post({ client_name: "No loops" }))).json()) as Record<string, any>;
    const begun = Date.now();
    const pending = tokenPost(post({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: start.device_code, wait: "10" }, true));
    setTimeout(() => void decideDeviceGrant(database, start.user_code.replace("-", ""), ids.alice, true), 1_000);
    // A second wait stacked on the same code is turned away at once, not held.
    await Bun.sleep(100);
    const stacked = (await (await tokenPost(post({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: start.device_code, wait: "10" }, true))).json()) as Record<string, any>;
    expect(stacked.error).toBe("slow_down");
    const issued = (await (await pending).json()) as Record<string, any>;
    expect(issued.access_token).toMatch(/^sck_/);
    expect(Date.now() - begun).toBeLessThan(5_000);
  });

  test("a denied device code gives the agent nothing", async () => {
    const start = (await (await devicePost(post({}))).json()) as Record<string, any>;
    await decideDeviceGrant(database, start.user_code.replace("-", ""), ids.alice, false);
    const result = (await (await tokenPost(post({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: start.device_code }))).json()) as Record<string, any>;
    expect(result.error).toBe("access_denied");
  });

  test("OAuth: register, consent, code with PKCE, rotating refresh tokens, reuse revokes the sign-in", async () => {
    const registered = await registerPost(post({ client_name: "Claude Code", redirect_uris: ["http://localhost:43123/callback"] }));
    expect(registered.status).toBe(201);
    const client = (await registered.json()) as Record<string, any>;
    expect(client.client_id).toMatch(/^scc_/);
    expect((await registerPost(post({ redirect_uris: ["http://evil.example/cb"] }))).status).toBe(400);

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const params = { response_type: "code", client_id: client.client_id, redirect_uri: "http://localhost:43123/callback", code_challenge: challenge, code_challenge_method: "S256", state: "xyz" };
    // An unregistered redirect is never followed.
    expect(await checkAuthorize({ ...params, redirect_uri: "http://localhost:1/other" })).toMatchObject({ ok: false, show: expect.any(String) });
    // No PKCE: the error goes back to the client.
    expect(await checkAuthorize({ ...params, code_challenge: undefined })).toMatchObject({ ok: false, redirect: expect.stringContaining("error=invalid_request") });
    const checked = await checkAuthorize(params);
    if (!checked.ok) throw new Error("expected a valid request");
    const back = new URL(await issueCode(checked.request, ids.alice));
    expect(back.searchParams.get("state")).toBe("xyz");
    expect(back.searchParams.get("iss")).toBe(BASE);
    const code = back.searchParams.get("code")!;

    const exchange = (verifierUsed: string) => tokenPost(post({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: params.redirect_uri, code_verifier: verifierUsed }, true));
    expect(((await (await exchange(randomBytes(32).toString("base64url"))).json()) as Record<string, any>).error).toBe("invalid_grant");
    // The wrong verifier spent the code: codes are single use whatever happens.
    expect(((await (await exchange(verifier)).json()) as Record<string, any>).error).toBe("invalid_grant");

    const second = await issueCode(checked.request, ids.alice);
    const code2 = new URL(second).searchParams.get("code")!;
    const tokens = (await (await tokenPost(post({ grant_type: "authorization_code", code: code2, client_id: client.client_id, redirect_uri: params.redirect_uri, code_verifier: verifier }, true))).json()) as Record<string, any>;
    expect(tokens.access_token).toMatch(/^sca_/);
    expect(tokens.refresh_token).toMatch(/^scr_/);
    expect(tokens.expires_in).toBeGreaterThan(0);
    expect((await api(tokens.access_token, "GET", "/me")).body.user.login).toBe("alice");
    // A day-long MCP token can't mint a key that would outlive disconnecting it.
    expect((await api(tokens.access_token, "POST", "/keys", { name: "escape" })).body.error.code).toBe("key_required");
    // A refresh token is never a bearer token.
    expect((await api(tokens.refresh_token, "GET", "/me")).status).toBe(401);

    const refresh = (token: string) => tokenPost(post({ grant_type: "refresh_token", refresh_token: token, client_id: client.client_id }, true)).then((r) => r.json() as Promise<Record<string, any>>);
    const rotated = await refresh(tokens.refresh_token);
    expect(rotated.access_token).toMatch(/^sca_/);
    // The old access token went with the old refresh token.
    expect((await api(tokens.access_token, "GET", "/me")).status).toBe(401);
    expect((await api(rotated.access_token, "GET", "/me")).status).toBe(200);

    // Shown again a moment later (a retry): refused, but the sign-in survives.
    expect((await refresh(tokens.refresh_token)).error).toBe("invalid_grant");
    expect((await api(rotated.access_token, "GET", "/me")).status).toBe(200);
    // Shown again much later: it was copied, so the whole sign-in is revoked.
    await database.$client`update api_tokens set revoked_at = now() - interval '1 hour' where token_hash = ${createHash("sha256").update(tokens.refresh_token).digest("hex")}`;
    expect((await refresh(tokens.refresh_token)).error).toBe("invalid_grant");
    expect((await api(rotated.access_token, "GET", "/me")).status).toBe(401);
    expect((await refresh(rotated.refresh_token)).error).toBe("invalid_grant");
  });

  test("revocation endpoint", async () => {
    const key = await connectByDevice(ids.alice, "to revoke");
    expect((await api(key, "GET", "/me")).status).toBe(200);
    expect((await revokePost(post({ token: key }, true))).status).toBe(200);
    expect((await api(key, "GET", "/me")).status).toBe(401);
  });

  test("redirect URIs: https, loopback http, app schemes; never script or remote http", () => {
    expect(allowedRedirect("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(allowedRedirect("http://127.0.0.1:9999/cb")).toBe(true);
    expect(allowedRedirect("cursor://anysphere.cursor-retrieval/oauth/callback")).toBe(true);
    expect(allowedRedirect("http://example.com/cb")).toBe(false);
    expect(allowedRedirect("javascript:alert(1)")).toBe(false);
    expect(allowedRedirect("https://x.test/cb#frag")).toBe(false);
  });
});

describe.skipIf(!available)("REST API", () => {
  test("without a key: 401 that says how to connect, and points at OAuth metadata", async () => {
    const { status, headers, body } = await api(null, "GET", "/me");
    expect(status).toBe(401);
    expect(body.error.how_to_connect.docs).toBe(`${BASE}/docs/agents`);
    expect(headers.get("www-authenticate")).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource"`);
    expect((await api("sck_nope", "GET", "/me")).body.error.code).toBe("invalid_token");
  });

  test("the index needs no key and lists every operation", async () => {
    const { status, body } = await api(null, "GET", "");
    expect(status).toBe(200);
    expect(body.endpoints.length).toBe(OPERATIONS.length);
  });

  test("me: next steps from the account's state", async () => {
    const { body } = await api(aliceKey, "GET", "/me");
    expect(body.user.login).toBe("alice");
    expect(body.accounts.map((a: { login: string }) => a.login)).toEqual(["acme"]);
    expect(body.next_steps[0]).toMatchObject({ step: "claim_free_credits", account: "acme" });
    const bob = (await api(bobKey, "GET", "/me")).body;
    expect(bob.next_steps[0]).toMatchObject({ step: "ask_admin_to_join" });
  });

  test("repos by owner/name, and scoped to the person", async () => {
    expect((await api(aliceKey, "GET", "/repos")).body.repos.map((r: { full_name: string }) => r.full_name).sort()).toEqual(["acme/api", "acme/secret"]);
    expect((await api(bobKey, "GET", "/repos")).body.repos.map((r: { full_name: string }) => r.full_name)).toEqual(["acme/api"]);
    const repo = await api(aliceKey, "GET", "/repos/acme/api");
    expect(repo.status).toBe(200);
    expect(repo.body.open_findings).toEqual({ critical: 1, high: 1, medium: 1, low: 0 });
    expect(repo.body.deep_scan.free_first_deep_scan).toBe(true);
    expect((await api(aliceKey, "GET", `/repos/${ids.api}`)).body.full_name).toBe("acme/api");
    expect((await api(aliceKey, "GET", "/repos/ACME%2FAPI")).body.full_name).toBe("acme/api");
    expect((await api(bobKey, "GET", "/repos/acme/secret")).body.error.code).toBe("repo_not_found");
  });

  test("findings: filters, detail with the fix prompt, decisions", async () => {
    const all = (await api(aliceKey, "GET", "/findings")).body;
    expect(all.findings.map((f: { severity: string }) => f.severity)).toEqual(["critical", "critical", "high", "medium"]);
    const some = (await api(aliceKey, "GET", "/findings?severity=critical,high&repo=acme/api")).body;
    expect(some.findings.map((f: { title: string }) => f.title)).toEqual(["Finding f1", "Finding f2"]);
    expect((await api(aliceKey, "GET", "/findings?include_low_confidence=true&repo=acme/api")).body.findings).toHaveLength(4);
    expect((await api(aliceKey, "GET", "/findings?severity=urgent")).body.error.code).toBe("invalid_input");

    const id = ids.findings[0]!;
    const detail = (await api(aliceKey, "GET", `/findings/${id}`)).body;
    expect(detail).toMatchObject({ title: "Finding f1", status: "open", fix_prompt: "Fix the unscoped lookup at a.ts:2", attack_path: [{ file: "a.ts", line: 2, note: "sink", excerpt: "1| a\n2| b\n3| c" }] });
    expect((await api(aliceKey, "GET", `/findings/${id}/fix-prompt`)).body.prompt).toBe("Fix the unscoped lookup at a.ts:2");

    expect((await api(aliceKey, "PATCH", `/findings/${id}`, { status: "dismissed" })).body.error.code).toBe("reason_required");
    expect((await api(aliceKey, "PATCH", `/findings/${id}`, { status: "dismissed", reason: "accepted_risk" })).body).toMatchObject({ status: "dismissed", dismiss_reason: "accepted_risk" });
    // Resolving deletes the excerpts and the prompt.
    const resolved = (await api(aliceKey, "GET", `/findings/${id}`)).body;
    expect(resolved.fix_prompt).toBeNull();
    expect(resolved.attack_path[0].excerpt).toBeUndefined();
    expect((await api(aliceKey, "PATCH", `/findings/${id}`, { status: "fixed" })).body.error.code).toBe("invalid_transition");
    expect((await api(aliceKey, "PATCH", `/findings/${id}`, { status: "open" })).body.status).toBe("open");

    // One prompt for many: the literal path wins over /findings/{id}.
    const many = (await api(aliceKey, "GET", "/findings/prompt?repo=acme/api&severity=critical,high")).body;
    expect(many).toMatchObject({ format: "prompt", findings: 2, repos: ["acme/api"] });
    expect(many.text).toContain("Finding f2");
    expect((await api(aliceKey, "GET", "/findings/prompt?status=fixed")).body.error.code).toBe("not_open");
    expect(JSON.parse((await api(aliceKey, "GET", "/findings/prompt?format=json&repo=acme/api")).body.text)).toBeTruthy();

    // Bob can't see acme/secret's finding at all.
    expect((await api(bobKey, "GET", `/findings/${ids.secretFinding}`)).status).toBe(404);
    expect((await api(bobKey, "PATCH", `/findings/${ids.secretFinding}`, { status: "fixed" })).status).toBe(404);
  });

  test("account settings and the hacker: admins only, partial changes", async () => {
    expect((await api(bobKey, "PATCH", "/accounts/acme", { check_threshold: "low" })).body.error.code).toBe("not_admin");
    const changed = (await api(aliceKey, "PATCH", "/accounts/acme", { check_threshold: "critical", email_notifications: false, first_target: "acme/secret" })).body;
    expect(changed.settings).toMatchObject({ check_threshold: "critical", email_notifications: false, first_target_repo_id: ids.secret });
    expect((await api(aliceKey, "PATCH", "/accounts/acme", { first_target: "other/repo" })).body.error.code).toBe("invalid_first_target");

    expect((await api(aliceKey, "PATCH", "/accounts/acme/hacker", { voice: "chatty" })).body.error.issues[0].field).toBe("voice");
    expect((await api(aliceKey, "PATCH", "/accounts/acme/hacker", { handle: "zero cool", voice: "paranoid" })).body.hacker).toMatchObject({ handle: "zero cool", voice: "paranoid" });
    // Only what's given changes.
    expect((await api(aliceKey, "PATCH", "/accounts/acme/hacker", { voice: "dry" })).body.hacker).toMatchObject({ handle: "zero cool", voice: "dry" });
    expect((await api(aliceKey, "GET", "/accounts/acme")).body.hacker).toMatchObject({ handle: "zero cool", recruited: true });
    expect((await api(aliceKey, "PATCH", "/accounts/acme/hacker", { handle: "x".repeat(40) })).status).toBe(422);
    expect((await api(aliceKey, "GET", "/accounts/nobody")).body.error.code).toBe("account_not_found");
    // The billing contact is for admins only.
    await api(aliceKey, "PATCH", "/accounts/acme", { company: { name: "Acme Inc", email: "billing@example.com" } });
    expect((await api(aliceKey, "GET", "/accounts/acme")).body.settings.company).toEqual({ name: "Acme Inc", email: "billing@example.com" });
    expect((await api(bobKey, "GET", "/accounts/acme")).body.settings.company).toBeNull();
  });

  test("billing: no plan refuses deep scans; free credits; a first purchase needs Stripe, then the card is charged", async () => {
    const refused = await api(aliceKey, "POST", "/repos/acme/api/scans");
    expect(refused.status).toBe(402);
    expect(refused.body.error.code).toBe("no_plan");

    const billing = (await api(aliceKey, "GET", "/accounts/acme/billing")).body;
    expect(billing).toMatchObject({ plan: null, card_on_file: false, free_credits: { open: true, credits: 20 } });
    expect((await api(bobKey, "POST", "/accounts/acme/billing/claim")).body.error.code).toBe("not_admin");
    expect((await api(aliceKey, "PUT", "/accounts/acme/billing/auto-top-up", { enabled: true })).body.error.code).toBe("needs_paid_plan");

    const claimed = await api(aliceKey, "POST", "/accounts/acme/billing/claim");
    expect(claimed.body).toMatchObject({ status: "claimed", credits: 20, plan: { id: "trial" } });
    // Claiming again (a retry) is harmless: still claimed, nothing granted twice.
    expect((await api(aliceKey, "POST", "/accounts/acme/billing/claim")).body).toMatchObject({ status: "claimed", credits: 20 });

    // The first deep scan is free; a second one of the same repo while it runs is refused.
    const scan = await api(aliceKey, "POST", "/repos/acme/api/scans");
    expect(scan.status).toBe(202);
    expect(scan.body.scan).toMatchObject({ kind: "deep", repo: { full_name: "acme/api" }, done: false });
    expect(started).toContain(scan.body.scan.id);
    const again = await api(aliceKey, "POST", "/repos/acme/api/scans");
    expect(again.body.error).toMatchObject({ code: "already_running", scan_id: scan.body.scan.id });

    // Following it: get_scan waits, and returns as soon as it is done.
    await database.$client`update scans set status = 'completed', finished_at = now() where id = ${scan.body.scan.id}`;
    const waited = Date.now();
    expect((await api(aliceKey, "GET", `/scans/${scan.body.scan.id}?wait=5`)).body).toMatchObject({ status: "completed", done: true });
    expect(Date.now() - waited).toBeLessThan(2_000);
    const events = (await api(aliceKey, "GET", `/scans/${scan.body.scan.id}/events?after=0`)).body;
    expect(events.done).toBe(true);
    expect((await api(bobKey, "GET", `/scans/${scan.body.scan.id}`)).status).toBe(200);
    expect((await api(aliceKey, "GET", "/scans?kind=deep")).body.scans[0].id).toBe(scan.body.scan.id);

    // On free credits, buying joins the plan through Stripe Checkout.
    const quote = (await api(aliceKey, "POST", "/accounts/acme/billing/quote", { credits: 25 })).body;
    expect(quote.payment).toBe("checkout");
    const tooDear = await api(aliceKey, "POST", "/accounts/acme/billing/purchase", { credits: 25, max_usd: 1 });
    expect(tooDear.body.error.code).toBe("over_max_usd");
    const checkout = (await api(aliceKey, "POST", "/accounts/acme/billing/purchase", { credits: 25 })).body;
    expect(checkout).toMatchObject({ status: "checkout_required", checkout_url: expect.stringContaining("checkout.test") });
    // Joining turns auto top-up on unless asked not to, and says so.
    expect(checkout.message).toContain("Auto top-up is on");
    const [joined] = await database.$client<Array<{ choice: unknown }>>`select settings->'autoTopUp' as choice from orgs where id = ${ids.acme}`;
    expect(joined!.choice).toEqual({ enabled: true, quantity: 25, monthlyLimitUsd: 500 });

    // With the card on file, credits are charged at once.
    const charged = (await api(aliceKey, "POST", "/accounts/acme/billing/purchase", { credits: 10 })).body;
    expect(charged.status).toBe("charged");
    const auto = (await api(aliceKey, "PUT", "/accounts/acme/billing/auto-top-up", { enabled: true, credits: 10, monthly_limit_usd: 60 })).body;
    expect(auto.auto_top_up).toMatchObject({ enabled: true, credits: 10, monthly_limit_usd: 60 });
    // Left out, the limit stays; null removes it.
    expect((await api(aliceKey, "PUT", "/accounts/acme/billing/auto-top-up", { enabled: true })).body.auto_top_up).toMatchObject({ monthly_limit_usd: 60 });
    expect((await api(aliceKey, "PUT", "/accounts/acme/billing/auto-top-up", { enabled: true, monthly_limit_usd: null })).body.auto_top_up).toMatchObject({ monthly_limit_usd: null });
    expect((await api(aliceKey, "GET", "/accounts/acme/billing")).body.auto_top_up).toMatchObject({ enabled: true, times_per_month_max: null });
    expect((await api(aliceKey, "POST", "/accounts/acme/billing/portal")).body.url).toBeString();
  });

  test("keys: create, list, revoke the current one", async () => {
    const created = await api(aliceKey, "POST", "/keys", { name: "CI\u0000\n job" });
    expect(created.status).toBe(201);
    expect(created.body.key).toMatch(/^sck_/);
    const list = (await api(created.body.key, "GET", "/keys")).body.keys;
    expect(list.find((k: { current: boolean }) => k.current)).toMatchObject({ name: "CI job", kind: "api_key" });
    expect(list.some((k: { kind: string }) => k.kind === "mcp_client")).toBe(false);
    expect((await api(created.body.key, "DELETE", "/keys/current")).body.revoked).toBe(true);
    expect((await api(created.body.key, "GET", "/me")).status).toBe(401);
    // Bob can't revoke Alice's keys.
    const alices = (await api(aliceKey, "GET", "/keys")).body.keys[0];
    expect((await api(bobKey, "DELETE", `/keys/${alices.id}`)).status).toBe(404);
  });

  test("wrong method and unknown paths say what to do", async () => {
    expect((await api(aliceKey, "DELETE", "/findings")).status).toBe(405);
    expect((await api(aliceKey, "GET", "/nope")).body.error.code).toBe("no_such_endpoint");
    expect((await api(aliceKey, "POST", "/keys", "not json" as unknown)).status).toBe(400);
  });
});

describe.skipIf(!available)("MCP", () => {
  test("401 points MCP clients at OAuth for the MCP resource", async () => {
    const { status, headers } = await mcp(null, "initialize", { protocolVersion: "2025-06-18" });
    expect(status).toBe(401);
    expect(headers.get("www-authenticate")).toContain(`${BASE}/.well-known/oauth-protected-resource/api/mcp`);
  });

  test("initialize, list tools, call them", async () => {
    const init = await mcp(aliceKey, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(init.body!.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "sandchest" }, capabilities: { tools: {} } });
    expect((await mcp(aliceKey, "notifications/initialized", undefined, null)).status).toBe(202);
    expect((await mcp(aliceKey, "initialize", { protocolVersion: "1999-01-01" })).body!.result.protocolVersion).toBe("2025-11-25");

    const list = await mcp(aliceKey, "tools/list");
    const tools = list.body!.result.tools as Array<{ name: string; inputSchema: Record<string, any>; annotations: Record<string, boolean> }>;
    expect(tools.map((t) => t.name)).toEqual(OPERATIONS.map((op) => op.name));
    for (const tool of tools) expect(tool.inputSchema.type).toBe("object");
    expect(tools.find((t) => t.name === "get_finding")!.annotations.readOnlyHint).toBe(true);
    expect(JSON.stringify(tools)).not.toContain("$schema");

    const me = await mcp(aliceKey, "tools/call", { name: "get_me", arguments: {} });
    expect(me.body!.result.structuredContent.user.login).toBe("alice");
    expect(JSON.parse(me.body!.result.content[0].text).user.login).toBe("alice");

    const missing = await mcp(aliceKey, "tools/call", { name: "get_finding", arguments: { id: "3f1c2b8e-1d2a-4b7c-9e0f-123456789abc" } });
    expect(missing.body!.result.structuredContent.error.code).toBe("not_found");
    expect((await mcp(bobKey, "tools/call", { name: "get_finding", arguments: { id: ids.secretFinding } })).body!.result.isError).toBe(true);
    expect((await mcp(aliceKey, "tools/call", { name: "nope", arguments: {} })).body!.error.code).toBe(-32602);
    expect((await mcp(aliceKey, "bogus/method")).body!.error.code).toBe(-32601);
  });
});

describe.skipIf(!available)("anonymous endpoints are limited", () => {
  // Each test sends from its own address, so their limits don't meet.
  const from = (ip: string, body: unknown, form = false) => {
    const request = post(body, form);
    request.headers.set("x-forwarded-for", ip);
    return request;
  };
  const count = async (table: typeof schema.oauthClients | typeof schema.deviceGrants) => (await database.select({ id: table.id }).from(table)).length;
  const devicePoll = (ip: string, deviceCode: string, wait?: string) => tokenPost(from(ip, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode, ...(wait ? { wait } : {}) }, true));

  test("registration: one address gets 20 clients, the 21st is refused before anything is stored", async () => {
    const before = await count(schema.oauthClients);
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await registerPost(from("203.0.113.1", { client_name: `Burst ${i}`, redirect_uris: ["https://client.example/cb"] }))).status);
    expect(statuses.slice(0, 20).every((status) => status === 201)).toBe(true);
    expect(statuses[20]).toBe(429);
    expect((await count(schema.oauthClients)) - before).toBe(20);
    // Someone else registering at the same moment is unaffected, with the full 1-10 redirect URIs.
    const uris = Array.from({ length: 10 }, (_, i) => `http://127.0.0.1:${40_000 + i}/callback`);
    expect((await registerPost(from("203.0.113.9", { client_name: "Cursor", redirect_uris: uris }))).status).toBe(201);
  });

  test("device codes: one address gets 20, the 21st is refused before anything is stored", async () => {
    const before = await count(schema.deviceGrants);
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await devicePost(from("203.0.113.2", { client_name: `Burst ${i}` }))).status);
    expect(statuses.slice(0, 20).every((status) => status === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
    expect((await count(schema.deviceGrants)) - before).toBe(20);
  });

  test("device polls: one address gets 60 a minute", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await devicePoll("203.0.113.3", `scd_${randomBytes(16).toString("hex")}`)).status);
    expect(statuses.slice(0, 60).every((status) => status === 400)).toBe(true);
    expect(statuses[60]).toBe(429);
  });

  test("waiting polls: one address holds at most 5 open, and a sixth is answered at once", async () => {
    const starts: Array<Record<string, any>> = [];
    for (let i = 0; i < 6; i++) starts.push((await (await devicePost(from("203.0.113.4", { client_name: `Waiter ${i}` }))).json()) as Record<string, any>);
    const held = starts.slice(0, 5).map((start) => devicePoll("203.0.113.5", start.device_code, "50"));
    await Bun.sleep(100);
    const begun = Date.now();
    const sixth = await Promise.race([devicePoll("203.0.113.5", starts[5]!.device_code, "50"), Bun.sleep(1_500).then(() => "held" as const)]);
    expect(sixth).not.toBe("held");
    expect(Date.now() - begun).toBeLessThan(1_500);
    expect((sixth as Response).status).toBe(429);
    expect(((await (sixth as Response).json()) as Record<string, any>).error).toBe("slow_down");
    // The held ones still end the moment the person decides.
    for (const start of starts.slice(0, 5)) await decideDeviceGrant(database, start.user_code.replace("-", ""), ids.alice, false);
    for (const response of await Promise.all(held)) expect(((await response.json()) as Record<string, any>).error).toBe("access_denied");
    // With them closed, the address may wait again.
    const again = (await (await devicePost(from("203.0.113.4", {}))).json()) as Record<string, any>;
    const waiting = devicePoll("203.0.113.5", again.device_code, "50");
    setTimeout(() => void decideDeviceGrant(database, again.user_code.replace("-", ""), ids.alice, false), 500);
    expect(((await (await waiting).json()) as Record<string, any>).error).toBe("access_denied");
  });

  test("across every address and server instance, at most 1,000 clients and device codes an hour", async () => {
    const noise = Array.from({ length: 1_000 }, (_, i) => i);
    await database.insert(schema.oauthClients).values(noise.map((i) => ({ id: `scc_noise${i}`, name: "noise", redirectUris: ["https://noise.example/cb"] })));
    await database.insert(schema.deviceGrants).values(noise.map((i) => ({ deviceCodeHash: `noise${i}`, userCode: `NOISE${String(i).padStart(4, "0")}`, clientName: "noise", expiresAt: new Date(Date.now() + 60_000) })));
    try {
      const clients = await count(schema.oauthClients);
      expect((await registerPost(from("198.51.100.1", { redirect_uris: ["https://client.example/cb"] }))).status).toBe(429);
      expect(await count(schema.oauthClients)).toBe(clients);
      const grants = await count(schema.deviceGrants);
      expect((await devicePost(from("198.51.100.1", {}))).status).toBe(429);
      expect(await count(schema.deviceGrants)).toBe(grants);
    } finally {
      await database.$client`delete from oauth_clients where name = 'noise'`;
      await database.$client`delete from device_grants where client_name = 'noise'`;
    }
    // Rows older than the hour don't count against it.
    await database.insert(schema.oauthClients).values(noise.map((i) => ({ id: `scc_old${i}`, name: "old", redirectUris: ["https://noise.example/cb"], createdAt: new Date(Date.now() - 2 * 3_600_000) })));
    expect((await registerPost(from("198.51.100.2", { redirect_uris: ["https://client.example/cb"] }))).status).toBe(201);
    await database.$client`delete from oauth_clients where name = 'old'`;
  });
});

describe("routing and docs", () => {
  test("paths: ids, owner/name in two segments, literals", () => {
    expect(matchPath("/repos/{repo}", ["repos", "acme", "api"])).toEqual({ repo: "acme/api" });
    expect(matchPath("/repos/{repo}/scans", ["repos", "acme", "api", "scans"])).toEqual({ repo: "acme/api" });
    expect(matchPath("/repos/{repo}", ["repos", "3f1c2b8e-1d2a-4b7c-9e0f-123456789abc"])).toEqual({ repo: "3f1c2b8e-1d2a-4b7c-9e0f-123456789abc" });
    expect(matchPath("/repos/{repo}", ["repos", "acme", "api", "scans"])).toBeUndefined();
    expect(matchPath("/accounts/{account}/billing", ["accounts", "acme", "billing"])).toEqual({ account: "acme" });
  });

  test("every operation has a unique name and path, and the OpenAPI document covers them", async () => {
    expect(new Set(OPERATIONS.map((op) => op.name)).size).toBe(OPERATIONS.length);
    expect(new Set(OPERATIONS.map((op) => `${op.method} ${op.path}`)).size).toBe(OPERATIONS.length);
    const doc = (await (await openApiGet()).json()) as { paths: Record<string, Record<string, { operationId: string }>> };
    const ops = Object.values(doc.paths).flatMap((methods) => Object.values(methods).map((m) => m.operationId));
    expect(ops.sort()).toEqual(OPERATIONS.map((op) => op.name).sort());
  });
});
