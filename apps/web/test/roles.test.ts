/**
 * Who may do what, over every operation the API and MCP server have, against
 * a real Postgres with GitHub and billing faked. Seven people on one account:
 *
 *   alice  admin on GitHub              ivy  invited as an admin
 *   bob    can push to acme/api only     mo   invited as a member
 *   dee    invited as an admin, then made a member
 *   olga   admin of another account     rex  invited as a member, then removed
 *
 * Every operation is listed below with what it needs; a new operation fails
 * the first test until it is. Admin operations: alice and ivy pass, everyone
 * else is refused. Repository operations: everyone who can see acme/api
 * passes, the others can't even see it. Lists: each sees only their own.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  acceptInvite,
  applyMatches,
  createDb,
  createInvite,
  matchKey,
  removeMember,
  saveInventory,
  schema,
  setMemberRole,
  upsertAdvisories,
  upsertFindings,
  upsertInstallation,
  type Db,
  type FindingInput,
} from "@sandchest/db";
import { migrate } from "@sandchest/db/migrate";
import type { GitHubApp } from "@sandchest/github";
import { POST as mcpPost } from "@/app/api/mcp/route";
import { storeAccess } from "@/server/access";
import { handleRest } from "@/server/agent/rest";
import { OPERATIONS } from "@/server/agent/registry";
import { issueKey } from "@/server/agent/tokens";
import { setAutumn, setStripe } from "@/server/billing";
import { resetConfig } from "@/server/config";
import { setServices } from "@/server/services";
import { setInventoryStarter, setScanStarter } from "@/server/start";
import { resetLimits } from "@/server/rate-limit";
import { FakeAutumn } from "./fake-autumn";

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest";
const NAME = `sandchest_roles_test_${process.pid}`;
const BASE = "https://sandchest.test";

let admin: postgres.Sql | undefined;
let database: Db;
let available = true;

const PEOPLE = ["alice", "bob", "ivy", "mo", "dee", "olga", "rex", "tess"] as const;
type Person = (typeof PEOPLE)[number];
const GITHUB_ID: Record<Person, number> = { alice: 601, bob: 602, ivy: 603, mo: 604, dee: 605, olga: 606, rex: 607, tess: 608 };

const user: Record<string, string> = {};
const key: Record<string, string> = {};
const ids = { acme: "", globex: "", api: "", web: "", core: "", apiFinding: "", webFinding: "", coreFinding: "", apiScan: "", coreScan: "" };

/** GitHub as one person's token sees it (installation 11 is acme, 12 globex). */
function github(person: Person): typeof fetch {
  const access: Record<string, Array<{ id: number; login: string; repos: Array<{ id: number; push?: boolean; admin?: boolean }>; orgAdmin?: boolean }>> = {
    alice: [{ id: 11, login: "acme", repos: [{ id: 1, admin: true }, { id: 2, admin: true }], orgAdmin: true }],
    bob: [{ id: 11, login: "acme", repos: [{ id: 1, push: true }] }],
    olga: [{ id: 12, login: "globex", repos: [{ id: 9, admin: true }], orgAdmin: true }],
  };
  const mine = access[person] ?? [];
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(String(input));
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/user") return json({ id: GITHUB_ID[person], login: person });
    if (url.pathname === "/user/installations") return json({ installations: mine.map(({ id, login }) => ({ id, account: { id: id * 10, login, type: "Organization" }, suspended_at: null })) });
    const repos = /^\/user\/installations\/(\d+)\/repositories$/.exec(url.pathname);
    if (repos) return json({ repositories: mine.find((i) => i.id === Number(repos[1]))!.repos.map((r) => ({ id: r.id, permissions: { admin: !!r.admin, push: !!r.push || !!r.admin, pull: true } })) });
    const membership = /^\/user\/memberships\/orgs\/(.+)$/.exec(url.pathname);
    if (membership) return mine.find((i) => i.login === decodeURIComponent(membership[1]!))?.orgAdmin ? json({ state: "active", role: "admin" }) : json({ message: "Not Found" }, 404);
    return json({ message: `unexpected ${url.pathname}` }, 500);
  }) as typeof fetch;
}

/** Reads everyone's access from GitHub again, as the dashboard does every few minutes. */
async function refreshAll() {
  for (const person of PEOPLE) await storeAccess(user[person]!, person, { fetch: github(person), maxAttempts: 1 });
}

let tokenSeq = 0;
/** Alice invites `person` as `role` and they accept, the way the dashboard does it. */
async function join(person: Person, role: "member" | "admin") {
  const tokenHash = `join-${person}-${++tokenSeq}`;
  const invite = await createInvite(database, { userId: user.alice!, orgId: ids.acme, invitee: { githubUserId: GITHUB_ID[person], githubLogin: person }, role, tokenHash });
  if (!invite.ok) throw new Error(`invite ${person}: ${invite.reason}`);
  const joined = await acceptInvite(database, { userId: user[person]!, tokenHash, identity: { githubUserId: GITHUB_ID[person], verifiedEmails: [] } });
  if (!joined.ok) throw new Error(`join ${person}: ${joined.reason}`);
}

function finding(fingerprint: string): FindingInput {
  return {
    fingerprint,
    severity: "high",
    confidence: "high",
    category: "broken_access_control",
    cwe: "CWE-639",
    title: `Finding ${fingerprint}`,
    impact: "Reads other customers' invoices.",
    entryPoint: { file: "a.ts", line: 1, description: "GET /x" },
    attackPath: [{ file: "a.ts", line: 2, note: "sink", excerpt: "1| a\n2| b" }],
    attacker: "any_user",
    preconditions: "Any user",
    proofOfConcept: "curl /x",
    fixGuidance: "Scope it.",
    guarantees: ["Scoped"],
    mustNotBreak: [],
    regressionTest: "Request another org's invoice.",
    fixPrompt: "Fix it",
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
  Object.assign(process.env, { DATABASE_URL: url.toString(), GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "unused", GITHUB_WEBHOOK_SECRET: "unused", SANDCHEST_APP_URL: BASE, GITHUB_APP_SLUG: "sandchest-test" });
  resetConfig();
  database = createDb(url.toString(), { max: 8 });
  await migrate(database);
  setServices({ db: database, github: { installation: () => ({ branchSha: async () => "sha1", repositories: async () => [] }) } as unknown as GitHubApp });
  setAutumn(new FakeAutumn());
  // A Stripe that fails every call: enough to show who gets past the admin check to it.
  setStripe(new Proxy({}, { get: () => new Proxy({}, { get: () => async () => Promise.reject(new Error("fake stripe")) }) }) as unknown as Parameters<typeof setStripe>[0]);
  setScanStarter(async () => {});
  setInventoryStarter(async () => {});

  const acme = await upsertInstallation(database, 11, { githubAccountId: 110, githubLogin: "acme", type: "Organization" }, [
    { githubRepoId: 1, fullName: "acme/api", private: true, defaultBranch: "main" },
    { githubRepoId: 2, fullName: "acme/web", private: true, defaultBranch: "main" },
  ]);
  const globex = await upsertInstallation(database, 12, { githubAccountId: 120, githubLogin: "globex", type: "Organization" }, [{ githubRepoId: 9, fullName: "globex/core", private: true, defaultBranch: "main" }]);
  ids.acme = acme.org.id;
  ids.globex = globex.org.id;
  ids.api = acme.repos.find((r) => r.fullName === "acme/api")!.id;
  ids.web = acme.repos.find((r) => r.fullName === "acme/web")!.id;
  ids.core = globex.repos[0]!.id;
  for (const person of PEOPLE) {
    const [row] = await database.insert(schema.users).values({ name: person, email: `${person}@example.com`, login: person, githubUserId: GITHUB_ID[person] }).returning();
    user[person] = row!.id;
  }
  const scan = async (repoId: string, orgId: string) =>
    (await database.insert(schema.scans).values({ repoId, orgId, kind: "deep", status: "completed", trigger: "manual", headSha: "abc" }).returning())[0]!;
  const apiScan = await scan(ids.api, ids.acme);
  const webScan = await scan(ids.web, ids.acme);
  const coreScan = await scan(ids.core, ids.globex);
  ids.apiScan = apiScan.id;
  ids.coreScan = coreScan.id;
  ids.apiFinding = (await upsertFindings(database, ids.api, apiScan, [finding("api-1")])).ids[0]!;
  ids.webFinding = (await upsertFindings(database, ids.web, webScan, [finding("web-1")])).ids[0]!;
  ids.coreFinding = (await upsertFindings(database, ids.core, coreScan, [finding("core-1")])).ids[0]!;
  // A CVE installed in acme/api only.
  const next = { ecosystem: "npm", name: "next", version: "15.0.0" };
  await saveInventory(database, ids.api, "abc", new Date(), [
    { ...next, key: "next", manifest: "package-lock.json", direct: true, dev: false, usage: "product", approximate: false, importedAt: ["src/app/page.tsx:1"] },
  ]);
  await upsertAdvisories(database, [
    { id: "GHSA-role-test", vulnKey: "CVE-2026-0001", aliases: ["CVE-2026-0001"], summary: "s", details: "", severity: "high", score: null, vector: null, malicious: false, affected: [], references: [], publishedAt: null, modifiedAt: new Date(), withdrawnAt: null },
  ]);
  await applyMatches(database, { checked: [next], matches: new Map([[matchKey(next), ["GHSA-role-test"]]]), origin: "inventory", repoId: ids.api });

  await refreshAll();
  await join("ivy", "admin");
  await join("mo", "member");
  await join("dee", "admin");
  expect(await setMemberRole(database, user.alice!, ids.acme, user.dee!, "member")).toBe(true);
  await join("rex", "member");
  expect(await removeMember(database, user.alice!, ids.acme, user.rex!)).toBe(true);
  // Everything above survives GitHub being read again.
  await refreshAll();
  for (const person of PEOPLE) key[person] = (await issueKey(user[person]!, "test")).key;
});

afterAll(async () => {
  setAutumn(undefined);
  setStripe(undefined);
  setScanStarter(undefined);
  setInventoryStarter(undefined);
  if (!available) return;
  await database.$client.end();
  await admin!.unsafe(`drop database if exists ${NAME} with (force)`);
  await admin!.end();
});

async function api(person: Person, method: string, path: string, body?: unknown) {
  const url = new URL(`${BASE}/api/v1${path}`);
  const request = new Request(url, {
    method,
    headers: { authorization: `Bearer ${key[person]}`, ...(body !== undefined && { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const segments = url.pathname.replace(/^\/api\/v1\/?/, "").split("/").filter(Boolean);
  const response = await handleRest(request, segments);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

type Need = "admin" | "repo" | "own";
interface Case {
  need: Need;
  /** The request, made fresh for each person (with whatever it acts on set up first). */
  request: (person: Person) => Promise<{ method: string; path: string; body?: unknown }> | { method: string; path: string; body?: unknown };
}

const invitedEmail = (person: Person) => `new-${person}-${Math.random().toString(36).slice(2, 8)}@example.com`;

/** An invite alice sends, for revoke_invite to act on. */
async function pendingInvite(): Promise<string> {
  const invite = await createInvite(database, { userId: user.alice!, orgId: ids.acme, invitee: { email: invitedEmail("alice") }, tokenHash: `pending-${++tokenSeq}` });
  if (!invite.ok) throw new Error(invite.reason);
  return invite.id;
}

/** Makes tess an invited member again, for set_teammate_role and remove_teammate to act on. */
async function tessIsMember() {
  await database.$client`insert into org_members (org_id, user_id, role) values (${ids.acme}, ${user.tess!}, 'member') on conflict do nothing`;
}

/**
 * Every operation and what it needs. `admin`: an admin of acme. `repo`: can
 * see acme/api (or its finding or scan). `own`: anyone signed in; acts on, or
 * lists, only what's theirs.
 */
const CASES: Record<string, Case> = {
  get_me: { need: "own", request: () => ({ method: "GET", path: "/me" }) },
  list_api_keys: { need: "own", request: () => ({ method: "GET", path: "/keys" }) },
  create_api_key: { need: "own", request: () => ({ method: "POST", path: "/keys", body: { name: "matrix" } }) },
  revoke_api_key: { need: "own", request: async (person) => ({ method: "DELETE", path: `/keys/${(await issueKey(user[person]!, "to revoke")).id}` }) },
  list_accounts: { need: "own", request: () => ({ method: "GET", path: "/accounts" }) },
  get_account: { need: "repo", request: () => ({ method: "GET", path: "/accounts/acme" }) },
  update_account: { need: "admin", request: () => ({ method: "PATCH", path: "/accounts/acme", body: { check_threshold: "high" } }) },
  update_hacker: { need: "admin", request: () => ({ method: "PATCH", path: "/accounts/acme/hacker", body: { voice: "terse" } }) },
  list_team: { need: "admin", request: () => ({ method: "GET", path: "/accounts/acme/team" }) },
  invite_teammate: { need: "admin", request: (person) => ({ method: "POST", path: "/accounts/acme/team/invites", body: { invitee: invitedEmail(person) } }) },
  revoke_invite: { need: "admin", request: async () => ({ method: "DELETE", path: `/accounts/acme/team/invites/${await pendingInvite()}` }) },
  set_teammate_role: {
    need: "admin",
    request: async () => (await tessIsMember(), { method: "PATCH", path: `/accounts/acme/team/members/${user.tess}`, body: { role: "member" } }),
  },
  remove_teammate: { need: "admin", request: async () => (await tessIsMember(), { method: "DELETE", path: `/accounts/acme/team/members/${user.tess}` }) },
  get_billing: { need: "repo", request: () => ({ method: "GET", path: "/accounts/acme/billing" }) },
  quote_credits: { need: "admin", request: () => ({ method: "POST", path: "/accounts/acme/billing/quote", body: { credits: 2_500 } }) },
  buy_credits: { need: "admin", request: () => ({ method: "POST", path: "/accounts/acme/billing/purchase", body: { credits: 2_500 } }) },
  claim_free_credits: { need: "admin", request: () => ({ method: "POST", path: "/accounts/acme/billing/claim" }) },
  set_auto_top_up: { need: "admin", request: () => ({ method: "PUT", path: "/accounts/acme/billing/auto-top-up", body: { enabled: false } }) },
  open_billing_portal: { need: "admin", request: () => ({ method: "POST", path: "/accounts/acme/billing/portal" }) },
  set_invoice_details: {
    need: "admin",
    request: () => ({ method: "PUT", path: "/accounts/acme/billing/invoice-details", body: { name: "Acme", address: { line1: "1 Road", city: "Town", postal_code: "123", country: "GB" } } }),
  },
  list_repos: { need: "own", request: () => ({ method: "GET", path: "/repos" }) },
  get_repo: { need: "repo", request: () => ({ method: "GET", path: "/repos/acme/api" }) },
  update_repo: { need: "repo", request: () => ({ method: "PATCH", path: "/repos/acme/api", body: { pr_reviews: "auto" } }) },
  start_deep_scan: { need: "repo", request: () => ({ method: "POST", path: "/repos/acme/api/scans" }) },
  list_scans: { need: "own", request: () => ({ method: "GET", path: "/scans" }) },
  get_scan: { need: "repo", request: () => ({ method: "GET", path: `/scans/${ids.apiScan}` }) },
  get_scan_events: { need: "repo", request: () => ({ method: "GET", path: `/scans/${ids.apiScan}/events` }) },
  list_findings: { need: "own", request: () => ({ method: "GET", path: "/findings" }) },
  get_findings_prompt: { need: "own", request: () => ({ method: "GET", path: "/findings/prompt?format=markdown" }) },
  get_finding: { need: "repo", request: () => ({ method: "GET", path: `/findings/${ids.apiFinding}` }) },
  get_fix_prompt: { need: "repo", request: () => ({ method: "GET", path: `/findings/${ids.apiFinding}/fix-prompt` }) },
  update_finding: {
    need: "repo",
    request: async () => (await database.$client`update findings set status = 'open' where id = ${ids.apiFinding}`, { method: "PATCH", path: `/findings/${ids.apiFinding}`, body: { status: "fixed" } }),
  },
  get_overview: { need: "own", request: () => ({ method: "GET", path: "/overview" }) },
  list_cves: { need: "own", request: () => ({ method: "GET", path: "/cves" }) },
  get_cve: { need: "repo", request: () => ({ method: "GET", path: "/cves/CVE-2026-0001" }) },
  check_cves: { need: "repo", request: () => ({ method: "POST", path: "/repos/acme/api/cves/check" }) },
};

/** Who passes each kind of check. */
const ALLOWED: Record<Need, readonly Person[]> = {
  admin: ["alice", "ivy"],
  repo: ["alice", "bob", "ivy", "mo", "dee"],
  own: PEOPLE,
};
const REFUSED = new Set([401, 403, 404]);

describe.skipIf(!available)("every operation, as everyone", () => {
  test("every operation has a rule here", () => {
    expect(Object.keys(CASES).sort()).toEqual(OPERATIONS.map((op) => op.name).sort());
  });

  for (const [name, testCase] of Object.entries(CASES)) {
    test(`${name}: only ${testCase.need === "admin" ? "admins" : testCase.need === "repo" ? "people who can see acme/api" : "the person themselves"}`, async () => {
      for (const person of PEOPLE.filter((p) => p !== "tess")) {
        resetLimits();
        const { method, path, body } = await testCase.request(person);
        const { status, body: response } = await api(person, method, path, body);
        const allowed = ALLOWED[testCase.need].includes(person);
        const outcome = `${name} as ${person}: ${status} ${JSON.stringify(response).slice(0, 160)}`;
        if (allowed) expect(REFUSED.has(status), outcome).toBe(false);
        else {
          expect(REFUSED.has(status), outcome).toBe(true);
          // Someone who can see acme is told they're not an admin; anyone else, that there's nothing there.
          if (testCase.need === "admin") expect(status, outcome).toBe(["bob", "mo", "dee"].includes(person) ? 403 : 404);
        }
      }
    });
  }
});

describe.skipIf(!available)("what each person sees", () => {
  const repos = async (person: Person) => (await api(person, "GET", "/repos")).body.repos.map((r: { full_name: string }) => r.full_name).sort();
  const findings = async (person: Person) => (await api(person, "GET", "/findings")).body.findings.map((f: { id: string }) => f.id).sort();

  test("repositories: invited people see all of acme, GitHub decides for the rest", async () => {
    expect(await repos("alice")).toEqual(["acme/api", "acme/web"]);
    expect(await repos("ivy")).toEqual(["acme/api", "acme/web"]);
    expect(await repos("mo")).toEqual(["acme/api", "acme/web"]);
    expect(await repos("dee")).toEqual(["acme/api", "acme/web"]);
    expect(await repos("bob")).toEqual(["acme/api"]);
    expect(await repos("olga")).toEqual(["globex/core"]);
    expect(await repos("rex")).toEqual([]);
  });

  test("findings and scans: nothing of another account, nothing after removal", async () => {
    expect(await findings("mo")).toEqual([ids.apiFinding, ids.webFinding].sort());
    expect(await findings("bob")).toEqual([ids.apiFinding]);
    expect(await findings("olga")).toEqual([ids.coreFinding]);
    expect(await findings("rex")).toEqual([]);
    for (const person of ["mo", "ivy", "bob"] as const) {
      expect((await api(person, "GET", `/findings/${ids.coreFinding}`)).status).toBe(404);
      expect((await api(person, "GET", `/scans/${ids.coreScan}`)).status).toBe(404);
    }
    expect((await api("bob", "GET", `/findings/${ids.webFinding}`)).status).toBe(404);
    expect((await api("rex", "GET", `/findings/${ids.apiFinding}`)).status).toBe(404);
    const scans = (await api("mo", "GET", "/scans")).body.scans.map((s: { id: string }) => s.id);
    expect(scans).not.toContain(ids.coreScan);
  });

  test("accounts say who's an admin: GitHub's and invited admins are, members and the demoted aren't", async () => {
    const admin = async (person: Person) => (await api(person, "GET", "/accounts")).body.accounts.find((a: { login: string }) => a.login === "acme")?.admin;
    expect(await admin("alice")).toBe(true);
    expect(await admin("ivy")).toBe(true);
    expect(await admin("mo")).toBe(false);
    expect(await admin("dee")).toBe(false);
    expect(await admin("bob")).toBe(false);
    expect(await admin("olga")).toBeUndefined();
    expect(await admin("rex")).toBeUndefined();
  });

  test("the team as an admin sees it: roles and where they come from", async () => {
    const team = (await api("ivy", "GET", "/accounts/acme/team")).body;
    const by = (login: string) => team.people.find((p: { login: string }) => p.login === login);
    expect(by("alice")).toMatchObject({ role: "admin", via: "github", role_changeable: false });
    expect(by("ivy")).toMatchObject({ role: "admin", via: "invite", role_changeable: true });
    expect(by("mo")).toMatchObject({ role: "member", via: "invite", role_changeable: true });
    expect(by("dee")).toMatchObject({ role: "member", via: "invite" });
    expect(by("bob")).toMatchObject({ role: "member", via: "github", role_changeable: false });
    expect(by("rex")).toBeUndefined();
    expect(by("olga")).toBeUndefined();
  });

  test("the same rules hold over MCP", async () => {
    const call = async (person: Person, name: string, args: Record<string, unknown>) => {
      const response = await mcpPost(
        new Request(`${BASE}/api/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key[person]}` },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
        }),
      );
      return (await response.json()) as { result?: { isError?: boolean; content: Array<{ text: string }> } };
    };
    expect((await call("mo", "update_account", { account: "acme", check_threshold: "low" })).result?.isError).toBe(true);
    expect((await call("mo", "list_team", { account: "acme" })).result?.isError).toBe(true);
    expect((await call("ivy", "list_team", { account: "acme" })).result?.isError).toBeFalsy();
    expect((await call("rex", "get_repo", { repo: "acme/api" })).result?.isError).toBe(true);
    expect((await call("mo", "get_repo", { repo: "acme/api" })).result?.isError).toBeFalsy();
  });
});

describe.skipIf(!available)("changing roles takes effect at once", () => {
  test("promote, demote and remove, with GitHub read again in between", async () => {
    const isAdmin = async () => (await api("mo", "GET", "/accounts/acme/team")).status;
    expect(await isAdmin()).toBe(403);
    // A member can't promote themselves, nor can bob.
    expect((await api("mo", "PATCH", `/accounts/acme/team/members/${user.mo}`, { role: "admin" })).status).toBe(403);
    expect((await api("bob", "PATCH", `/accounts/acme/team/members/${user.mo}`, { role: "admin" })).status).toBe(403);
    // An invited admin can.
    expect((await api("ivy", "PATCH", `/accounts/acme/team/members/${user.mo}`, { role: "admin" })).status).toBe(200);
    expect(await isAdmin()).toBe(200);
    await refreshAll();
    expect(await isAdmin()).toBe(200);
    expect((await api("ivy", "PATCH", `/accounts/acme/team/members/${user.mo}`, { role: "member" })).status).toBe(200);
    expect(await isAdmin()).toBe(403);
    await refreshAll();
    expect(await isAdmin()).toBe(403);
    // GitHub's admin can't be demoted or removed from Sandchest, by anyone.
    expect((await api("ivy", "PATCH", `/accounts/acme/team/members/${user.alice}`, { role: "member" })).status).toBe(404);
    expect((await api("ivy", "DELETE", `/accounts/acme/team/members/${user.alice}`)).status).toBe(404);
    expect((await api("alice", "GET", "/accounts/acme/team")).status).toBe(200);
    // Nor can anyone act on another account's team.
    expect((await api("olga", "PATCH", `/accounts/acme/team/members/${user.mo}`, { role: "admin" })).status).toBe(404);
    expect((await api("ivy", "GET", "/accounts/globex/team")).status).toBe(404);
  });
});
