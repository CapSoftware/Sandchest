/**
 * The dashboard's access rules and writes, against a real Postgres (local
 * docker) with GitHub faked: who sees which repos, who may change settings,
 * and what a person's decisions do to a finding. Skips without Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  applyFindingAction,
  createDb,
  dashboardFindings,
  dashboardRepos,
  findingForUser,
  notificationRecipients,
  schema,
  scanForUser,
  settingsOrgs,
  updateOrgSettings,
  upsertFindings,
  upsertInstallation,
  type Db,
  type FindingInput,
} from "@sandchest/db";
import { migrate } from "@sandchest/db/migrate";
import { criticalFindingEmail, deepScanEmail } from "@sandchest/email";
import { createHmac } from "node:crypto";
import { sessionUser } from "@sandchest/db";
import { storeAccess } from "@/server/access";
import { verifiedSessionToken } from "@/server/auth";
import { digState } from "@/lib/dig-state";
import { setServices } from "@/server/services";

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest";
const NAME = `sandchest_m3_test_${process.pid}`;

let admin: postgres.Sql | undefined;
let database: Db;
let available = true;

/** A fake GitHub API for one user's token: installations, their repos with roles, and org memberships. */
function fakeGithub(user: { id: number; login: string }, installations: Array<{ id: number; account: { id: number; login: string; type: "User" | "Organization" }; repos: Array<{ id: number; push?: boolean; admin?: boolean }>; orgAdmin?: boolean }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/user") return json(user);
    if (url.pathname === "/user/installations") return json({ installations: installations.map(({ id, account }) => ({ id, account })) });
    const repos = /^\/user\/installations\/(\d+)\/repositories$/.exec(url.pathname);
    if (repos) {
      const installation = installations.find((i) => i.id === Number(repos[1]))!;
      return json({ repositories: installation.repos.map((r) => ({ id: r.id, permissions: { admin: !!r.admin, push: !!r.push || !!r.admin, pull: true } })) });
    }
    const membership = /^\/user\/memberships\/orgs\/(.+)$/.exec(url.pathname);
    if (membership) {
      const installation = installations.find((i) => i.account.login === decodeURIComponent(membership[1]!));
      return installation?.orgAdmin ? json({ state: "active", role: "admin" }) : json({ message: "Not Found" }, 404);
    }
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
    fixPrompt: "prompt quoting 2| b",
  };
}

const SECRET = "test-secret-test-secret-test-secret-00";

let ids: { org: string; personal: string; api: string; web: string; secret: string; alice: string; bob: string; scan: string; findings: string[] };

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
  Object.assign(process.env, { DATABASE_URL: url.toString(), GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "unused", GITHUB_WEBHOOK_SECRET: "unused", SANDCHEST_APP_URL: "https://sandchest.test" });
  database = createDb(url.toString(), { max: 5 });
  await migrate(database);
  setServices({ db: database });

  const acme = await upsertInstallation(database, 11, { githubAccountId: 100, githubLogin: "acme", type: "Organization" }, [
    { githubRepoId: 1, fullName: "acme/api", private: true, defaultBranch: "main" },
    { githubRepoId: 2, fullName: "acme/web", private: true, defaultBranch: "main" },
    { githubRepoId: 3, fullName: "acme/secret", private: true, defaultBranch: "main" },
  ]);
  const personal = await upsertInstallation(database, 12, { githubAccountId: 501, githubLogin: "alice", type: "User" }, [{ githubRepoId: 4, fullName: "alice/site", private: false, defaultBranch: "main" }]);
  const [alice] = await database.insert(schema.users).values({ name: "Alice", email: "alice@example.com", login: "alice" }).returning();
  const [bob] = await database.insert(schema.users).values({ name: "Bob", email: "502+bob@users.noreply.github.com", login: "bob" }).returning();
  const [scan] = await database.insert(schema.scans).values({ repoId: acme.repos[0]!.id, orgId: acme.org.id, kind: "deep", status: "completed", trigger: "manual", headSha: "abc" }).returning();
  const { ids: findingIds } = await upsertFindings(database, acme.repos[0]!.id, scan!, [finding("f1", "critical"), finding("f2", "high"), finding("f3", "low", "low")]);
  await upsertFindings(database, acme.repos[2]!.id, scan!, [finding("s1", "critical")]);
  await database.update(schema.scans).set({ stats: { findingIds } });
  ids = { org: acme.org.id, personal: personal.org.id, api: acme.repos[0]!.id, web: acme.repos[1]!.id, secret: acme.repos[2]!.id, alice: alice!.id, bob: bob!.id, scan: scan!.id, findings: findingIds };
});

afterAll(async () => {
  if (!available) return;
  await database.$client.end();
  await admin!.unsafe(`drop database if exists ${NAME} with (force)`);
  await admin!.end();
});

describe("access from GitHub", () => {
  test("push access or higher makes a repo visible; read and triage do not", async () => {
    if (!available) return;
    // Alice: admin of acme, push on api, read-only on secret, owner of her personal account.
    await storeAccess(ids.alice, "token-a", {
      fetch: fakeGithub({ id: 501, login: "alice" }, [
        { id: 11, account: { id: 100, login: "acme", type: "Organization" }, repos: [{ id: 1, push: true }, { id: 2, admin: true }, { id: 3 }], orgAdmin: true },
        { id: 12, account: { id: 501, login: "alice", type: "User" }, repos: [{ id: 4, admin: true }] },
        // An installation Sandchest has never recorded is ignored.
        { id: 99, account: { id: 900, login: "other", type: "Organization" }, repos: [{ id: 50, admin: true }] },
      ]),
    });
    const repos = await dashboardRepos(database, ids.alice);
    expect(repos.map((r) => r.fullName).sort()).toEqual(["acme/api", "acme/web", "alice/site"]);
    const api = repos.find((r) => r.fullName === "acme/api")!;
    // Low-confidence findings are not counted.
    expect(api.open).toEqual({ critical: 1, high: 1, medium: 0, low: 0 });
    expect(api.lastScan?.id).toBe(ids.scan);

    const orgs = await settingsOrgs(database, ids.alice);
    expect(orgs.map((o) => [o.login, o.admin])).toEqual([["acme", true], ["alice", true]]);
  });

  test("a member who is not an admin sees repos but cannot change settings", async () => {
    if (!available) return;
    await storeAccess(ids.bob, "token-b", { fetch: fakeGithub({ id: 502, login: "bob" }, [{ id: 11, account: { id: 100, login: "acme", type: "Organization" }, repos: [{ id: 1, push: true }] }]) });
    expect((await dashboardRepos(database, ids.bob)).map((r) => r.fullName)).toEqual(["acme/api"]);
    expect(await updateOrgSettings(database, ids.bob, ids.org, { checkThreshold: "low" })).toBe(false);
    expect(await updateOrgSettings(database, ids.alice, ids.org, { checkThreshold: "critical" })).toBe(true);
    const [org] = await database.$client<Array<{ settings: { checkThreshold: string } }>>`select settings from orgs where id = ${ids.org}`;
    expect(org!.settings.checkThreshold).toBe("critical");
  });

  test("losing access on GitHub removes it here on the next refresh", async () => {
    if (!available) return;
    await storeAccess(ids.bob, "token-b", { fetch: fakeGithub({ id: 502, login: "bob" }, [{ id: 11, account: { id: 100, login: "acme", type: "Organization" }, repos: [{ id: 1 }] }]) });
    expect(await dashboardRepos(database, ids.bob)).toEqual([]);
    expect(await findingForUser(database, ids.bob, ids.findings[0]!)).toBeUndefined();
    expect(await scanForUser(database, ids.bob, ids.scan)).toBeUndefined();
  });
});

describe("findings", () => {
  test("lists only what the user can see, worst first, hiding low confidence unless asked", async () => {
    if (!available) return;
    const list = await dashboardFindings(database, ids.alice);
    expect(list.map((f) => f.title)).toEqual(["Finding f1", "Finding f2"]);
    expect(list[0]!.sink).toEqual({ file: "a.ts", line: 2 });
    expect((await dashboardFindings(database, ids.alice, { includeLowConfidence: true })).length).toBe(3);
    expect((await dashboardFindings(database, ids.alice, { severities: ["high"] })).map((f) => f.title)).toEqual(["Finding f2"]);
    // acme/secret's critical is invisible: read-only access.
    expect(list.some((f) => f.title === "Finding s1")).toBe(false);
  });

  test("dismissing records who and why, and deletes the code excerpts and prompt", async () => {
    if (!available) return;
    const id = ids.findings[0]!;
    expect(await applyFindingAction(database, ids.bob, id, { type: "fix" })).toBe(false);
    expect(await applyFindingAction(database, ids.alice, id, { type: "dismiss", reason: "accepted_risk" })).toBe(true);
    const row = (await findingForUser(database, ids.alice, id))!;
    expect(row.finding.status).toBe("dismissed");
    expect(row.finding.dismissReason).toBe("accepted_risk");
    expect(row.finding.fixPrompt).toBe("");
    expect((row.finding.attackPath as Array<Record<string, unknown>>)[0]).not.toHaveProperty("excerpt");
    expect(row.history[0]).toMatchObject({ type: "dismissed", login: "alice" });
    // Dismissing twice changes nothing.
    expect(await applyFindingAction(database, ids.alice, id, { type: "dismiss", reason: "wont_fix" })).toBe(false);
    expect(await applyFindingAction(database, ids.alice, id, { type: "reopen" })).toBe(true);
    expect((await findingForUser(database, ids.alice, id))!.finding).toMatchObject({ status: "open", dismissReason: null });
  });
});

describe("notifications", () => {
  test("go to people with access who have a real address", async () => {
    if (!available) return;
    await storeAccess(ids.bob, "token-b", { fetch: fakeGithub({ id: 502, login: "bob" }, [{ id: 11, account: { id: 100, login: "acme", type: "Organization" }, repos: [{ id: 1, push: true }] }]) });
    expect(await notificationRecipients(database, ids.api)).toEqual(["alice@example.com"]);
    expect(await notificationRecipients(database, ids.secret)).toEqual([]);
  });

  test("templates escape what the model wrote", () => {
    const email = criticalFindingEmail({ repo: "acme/api", findings: [{ title: "<script>alert(1)</script>", severity: "critical", url: "https://sandchest.test/findings/1" }] });
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.subject).toBe("Critical: <script>alert(1)</script>");
    expect(deepScanEmail({ repo: "acme/api", scanUrl: "https://sandchest.test/scans/1", findings: [] }).subject).toBe("Nothing buried in acme/api");
  });
});

describe("dig", () => {
  const now = new Date("2026-11-01T12:00:00Z");
  test("costs credits by size, waits out the cooldown, refuses huge repos", () => {
    expect(digState({ loc: 48_000, lastDeepScanAt: null, activeDeepScanId: null }, now)).toEqual({ state: "ready", credits: 15 });
    expect(digState({ loc: null, lastDeepScanAt: null, activeDeepScanId: null }, now)).toEqual({ state: "ready", credits: undefined });
    expect(digState({ loc: 2_000_000, lastDeepScanAt: null, activeDeepScanId: null }, now)).toEqual({ state: "too_large" });
    expect(digState({ loc: 10, lastDeepScanAt: new Date("2026-11-01T02:00:00Z"), activeDeepScanId: null }, now)).toEqual({ state: "cooling", retryAt: new Date("2026-11-02T02:00:00Z") });
    expect(digState({ loc: 10, lastDeepScanAt: null, activeDeepScanId: "s1" }, now)).toEqual({ state: "running", scanId: "s1" });
  });
});

describe("sessions", () => {
  const sign = (token: string, secret = SECRET) => `${token}.${createHmac("sha256", secret).update(token).digest("base64")}`;

  test("a cookie is trusted only with a valid signature", () => {
    if (!available) return;
    expect(verifiedSessionToken(sign("tok123"), SECRET)).toBe("tok123");
    expect(verifiedSessionToken(encodeURIComponent(sign("tok123")), SECRET)).toBe("tok123");
    expect(verifiedSessionToken(sign("tok123", "another-secret-another-secret-0000"), SECRET)).toBeUndefined();
    expect(verifiedSessionToken(sign("tok123").replace("tok123", "tok124"), SECRET)).toBeUndefined();
    expect(verifiedSessionToken("tok123", SECRET)).toBeUndefined();
    expect(verifiedSessionToken(undefined, SECRET)).toBeUndefined();
  });

  test("a session reads its user in one query, and expired sessions read nothing", async () => {
    if (!available) return;
    await database.insert(schema.sessions).values([
      { userId: ids.alice, token: "live-token", expiresAt: new Date(Date.now() + 60_000) },
      { userId: ids.alice, token: "old-token", expiresAt: new Date(Date.now() - 60_000) },
    ]);
    expect(await sessionUser(database, "live-token")).toMatchObject({ id: ids.alice, login: "alice" });
    expect(await sessionUser(database, "old-token")).toBeUndefined();
    expect(await sessionUser(database, "no-such-token")).toBeUndefined();
  });
});
