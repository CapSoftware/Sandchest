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
  setGithubIdentity,
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
import { sessionRefreshDue } from "@/server/session-token";
import { serializeSignedCookie } from "better-call";
import { digState } from "@/lib/dig-state";
import { resetConfig } from "@/server/config";
import { setServices } from "@/server/services";
import { setGithubApp } from "@/server/github-app";
import { setScanStarter } from "@/server/start";
import { handleWebhook } from "@/server/webhooks";
import type { GitHubApp } from "@sandchest/github";

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest";
const NAME = `sandchest_m3_test_${process.pid}`;

let admin: postgres.Sql | undefined;
let database: Db;
let available = true;

/** A fake GitHub API for one user's token: installations, their repos with roles, and org memberships. */
function fakeGithub(user: { id: number; login: string }, installations: Array<{ id: number; account: { id: number; login: string; type: "User" | "Organization" }; repos: Array<{ id: number; push?: boolean; admin?: boolean }>; orgAdmin?: boolean; suspended?: boolean }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/user") return json(user);
    if (url.pathname === "/user/installations") return json({ installations: installations.map(({ id, account, suspended }) => ({ id, account, suspended_at: suspended ? "2026-01-01T00:00:00Z" : null })) });
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
  resetConfig();
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
    // Installation 99 is unknown here: recording it is attempted (as if its webhook were late) and fails.
    const tried: number[] = [];
    setGithubApp({
      installation: (id: number) => ({
        repositories: async () => {
          tried.push(id);
          throw new Error("not this App's installation");
        },
      }),
    } as unknown as GitHubApp);
    await storeAccess(ids.alice, "token-a", {
      fetch: fakeGithub({ id: 501, login: "alice" }, [
        { id: 11, account: { id: 100, login: "acme", type: "Organization" }, repos: [{ id: 1, push: true }, { id: 2, admin: true }, { id: 3 }], orgAdmin: true },
        { id: 12, account: { id: 501, login: "alice", type: "User" }, repos: [{ id: 4, admin: true }] },
        // An installation Sandchest has never recorded and cannot record is left out.
        { id: 99, account: { id: 900, login: "other", type: "Organization" }, repos: [{ id: 50, admin: true }] },
      ]),
    });
    setGithubApp(undefined);
    expect(tried).toEqual([99]);
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

    // Auto top-up is saved the same way: merged into the settings object, the threshold untouched.
    expect(await updateOrgSettings(database, ids.alice, ids.org, { autoTopUp: { enabled: true, monthlyLimitUsd: 40 } })).toBe(true);
    const [after] = await database.$client<Array<{ settings: unknown; kind: string }>>`select settings, jsonb_typeof(settings) as kind from orgs where id = ${ids.org}`;
    expect(after).toEqual({ kind: "object", settings: { checkThreshold: "critical", autoTopUp: { enabled: true, monthlyLimitUsd: 40 } } });
  });

  test("an installation GitHub lists before its webhook arrives is recorded on the spot", async () => {
    if (!available) return;
    // Back from installing: GitHub redirects at once, and the installation webhook can land a moment later.
    const asked: number[] = [];
    setGithubApp({
      installation: (id: number) => ({
        repositories: async () => {
          asked.push(id);
          return [{ id: 70, full_name: "newco/app", private: true, default_branch: "main" }];
        },
      }),
    } as unknown as GitHubApp);
    const started: string[] = [];
    setScanStarter(async (scanId) => void started.push(scanId));
    try {
      await storeAccess(ids.bob, "token-b", {
        fetch: fakeGithub({ id: 502, login: "bob" }, [
          { id: 11, account: { id: 100, login: "acme", type: "Organization" }, repos: [{ id: 1, push: true }] },
          { id: 13, account: { id: 700, login: "newco", type: "Organization" }, repos: [{ id: 70, admin: true }], orgAdmin: true },
        ]),
      });
      expect(asked).toEqual([13]);
      expect((await dashboardRepos(database, ids.bob)).map((r) => r.fullName).sort()).toEqual(["acme/api", "newco/app"]);
      expect((await settingsOrgs(database, ids.bob)).find((o) => o.login === "newco")?.admin).toBe(true);
      // Recon starts as the webhook would (billing is off here), after the page, never holding it up.
      for (let i = 0; i < 100 && started.length === 0; i++) await Bun.sleep(10);
      expect(started.length).toBe(1);

      // The webhook arriving afterwards records nothing new and starts no second recon.
      const deps = { db: database, github: { installation: () => ({ repositories: async () => [{ id: 70, full_name: "newco/app", private: true, default_branch: "main" }] }) } as unknown as GitHubApp, startScan: async (scanId: string) => void started.push(scanId) };
      await handleWebhook(deps, "installation", "late-delivery", { action: "created", installation: { id: 13, account: { id: 700, login: "newco", type: "Organization" } } });
      expect(started.length).toBe(1);

      // A later refresh asks GitHub for nothing new.
      await storeAccess(ids.bob, "token-b", {
        fetch: fakeGithub({ id: 502, login: "bob" }, [{ id: 13, account: { id: 700, login: "newco", type: "Organization" }, repos: [{ id: 70, admin: true }], orgAdmin: true }]),
      });
      expect(asked).toEqual([13]);
    } finally {
      setGithubApp(undefined);
      setScanStarter(undefined);
      await database.$client`delete from scans where org_id in (select id from orgs where installation_id = 13)`;
      await database.$client`delete from orgs where installation_id = 13`;
    }
  });

  test("an installation that cannot be recorded yet leaves the rest of the refresh intact", async () => {
    if (!available) return;
    setGithubApp({
      installation: () => ({
        repositories: async () => {
          throw new Error("GitHub is down");
        },
      }),
    } as unknown as GitHubApp);
    try {
      await storeAccess(ids.bob, "token-b", {
        fetch: fakeGithub({ id: 502, login: "bob" }, [
          { id: 11, account: { id: 100, login: "acme", type: "Organization" }, repos: [{ id: 1, push: true }] },
          { id: 14, account: { id: 701, login: "later", type: "Organization" }, repos: [{ id: 71, admin: true }] },
        ]),
      });
      expect((await dashboardRepos(database, ids.bob)).map((r) => r.fullName)).toEqual(["acme/api"]);
      expect((await database.$client`select 1 from orgs where installation_id = 14`).length).toBe(0);
    } finally {
      setGithubApp(undefined);
    }
  });

  test("a suspended installation counts as gone", async () => {
    if (!available) return;
    await storeAccess(ids.bob, "token-b", {
      fetch: fakeGithub({ id: 502, login: "bob" }, [{ id: 11, account: { id: 100, login: "acme", type: "Organization" }, repos: [{ id: 1, push: true }], suspended: true }]),
    });
    expect(await dashboardRepos(database, ids.bob)).toEqual([]);
  });

  test("losing access on GitHub removes it here on the next refresh", async () => {
    if (!available) return;
    await storeAccess(ids.bob, "token-b", { fetch: fakeGithub({ id: 502, login: "bob" }, [{ id: 11, account: { id: 100, login: "acme", type: "Organization" }, repos: [{ id: 1 }] }]) });
    expect(await dashboardRepos(database, ids.bob)).toEqual([]);
    expect(await findingForUser(database, ids.bob, ids.findings[0]!)).toBeUndefined();
    expect(await scanForUser(database, ids.bob, ids.scan)).toBeUndefined();
  });

  test("records who the person is on GitHub, as GitHub reports it, and follows a rename", async () => {
    if (!available) return;
    // better-auth creates users without these (they are not user-settable), so sign-in and refreshes fill them in.
    const [carol] = await database.insert(schema.users).values({ name: "Carol", email: "carol@example.com" }).returning();
    const [ghost] = await database.insert(schema.users).values({ name: "Old", email: "old@example.com", githubUserId: 503, login: "carol" }).returning();
    const identity = async (id: string) => (await database.$client<Array<{ github_user_id: string | null; login: string | null }>>`select github_user_id, login from users where id = ${id}`)[0];

    // At sign-in only the account id is known.
    await setGithubIdentity(database, carol!.id, { id: 503 });
    expect(await identity(carol!.id)).toEqual({ github_user_id: "503", login: null });
    // The id is unique: a stale row claiming it gives it up.
    expect(await identity(ghost!.id)).toEqual({ github_user_id: null, login: "carol" });

    await storeAccess(carol!.id, "token-c", { fetch: fakeGithub({ id: 503, login: "carol" }, []) });
    expect(await identity(carol!.id)).toEqual({ github_user_id: "503", login: "carol" });
    await storeAccess(carol!.id, "token-c", { fetch: fakeGithub({ id: 503, login: "carol-renamed" }, []) });
    expect(await identity(carol!.id)).toEqual({ github_user_id: "503", login: "carol-renamed" });
    expect((await sessionUserFor(carol!.id))?.githubUserId).toBe(503);
    await database.$client`delete from users where id in ${database.$client([carol!.id, ghost!.id])}`;
  });
});

/** The viewer a page would see for this user: what the admin check reads. */
async function sessionUserFor(userId: string) {
  const token = `t-${userId}`;
  await database.insert(schema.sessions).values({ token, userId, expiresAt: new Date(Date.now() + 60_000) });
  try {
    return await sessionUser(database, token);
  } finally {
    await database.$client`delete from sessions where token = ${token}`;
  }
}

describe("free first dig", () => {
  test("the repos list says whether an org's next Dig is its free one", async () => {
    if (!available) return;
    const freeFor = async () => (await dashboardRepos(database, ids.alice)).find((r) => r.fullName === "acme/api")!.freeDig;
    await database.$client`update orgs set free_dig_scan_id = null where id = ${ids.org}`;
    expect(await freeFor()).toBe(true);
    // Used while its scan is queued, running or done; free again once it failed or is gone.
    await database.$client`update orgs set free_dig_scan_id = ${ids.scan} where id = ${ids.org}`;
    expect(await freeFor()).toBe(false);
    await database.$client`update scans set status = 'failed' where id = ${ids.scan}`;
    expect(await freeFor()).toBe(true);
    await database.$client`update scans set status = 'completed' where id = ${ids.scan}`;
    await database.$client`update orgs set free_dig_scan_id = gen_random_uuid() where id = ${ids.org}`;
    expect(await freeFor()).toBe(true);
    await database.$client`update orgs set free_dig_scan_id = null where id = ${ids.org}`;
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
    // A malformed escape is a bad cookie, not a server error.
    expect(verifiedSessionToken("abc%ZZ.def", SECRET)).toBeUndefined();
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

describe("better-auth's own cookies", () => {
  test("verify exactly as better-auth signs them, and use its cookie name", async () => {
    if (!available) return;
    // The cookie as better-auth (through better-call) writes it, then decoded once, as Next's cookies() reads it.
    const header = await serializeSignedCookie("better-auth.session_token", "tok-from-better-auth", SECRET, {});
    const value = decodeURIComponent(header.split(";")[0]!.split("=").slice(1).join("="));
    expect(verifiedSessionToken(value, SECRET)).toBe("tok-from-better-auth");
    expect(verifiedSessionToken(value, "another-secret-another-secret-0000")).toBeUndefined();
    // Over HTTPS better-auth prefixes the name; the check reads the same name.
    const { sessionCookieName } = await import("@/server/session-token");
    const { resetConfig } = await import("@/server/config");
    const before = process.env.SANDCHEST_APP_URL;
    process.env.SANDCHEST_APP_URL = "https://sandchest.test";
    resetConfig();
    expect(sessionCookieName()).toBe("__Secure-better-auth.session_token");
    process.env.SANDCHEST_APP_URL = before;
    resetConfig();
  });
});

describe("session expiry", () => {
  test("a session is extended once it is a day old, as better-auth does", () => {
    const now = Date.parse("2026-11-08T12:00:00Z");
    const day = 86_400_000;
    // Signed in just now: expires in 7 days, nothing to do.
    expect(sessionRefreshDue(new Date(now + 7 * day), now)).toBe(false);
    // Signed in 23 hours ago.
    expect(sessionRefreshDue(new Date(now + 6 * day + 3_600_000), now)).toBe(false);
    // Signed in a day ago or more: extend it.
    expect(sessionRefreshDue(new Date(now + 6 * day), now)).toBe(true);
    expect(sessionRefreshDue(new Date(now + 2 * day), now)).toBe(true);
  });
});
