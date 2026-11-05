/**
 * Teams against a real Postgres, with GitHub and email faked: only an org's
 * admins invite, revoke and remove; an invite works once, before it expires,
 * and only for the person it was sent to (a verified email on GitHub, or the
 * GitHub account); a member sees every repo of the org and nothing of any
 * other; leaving or being removed takes that away at once, without touching
 * what GitHub grants; reading access from GitHub keeps memberships; and the
 * limits on sending hold.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  acceptInvite,
  adminTeams,
  createDb,
  createInvite,
  dashboardRepos,
  findingForUser,
  INVITES_PER_ADDRESS_DAY,
  INVITES_PER_INVITEE_HOUR,
  inviteByTokenHash,
  leaveOrg,
  memberOrgIds,
  notificationRecipients,
  orgAdminContacts,
  orgForAdmin,
  setMemberRole,
  removeInstallation,
  removeMember,
  repoForUser,
  revokeInvite,
  schema,
  updateOrgSettings,
  upsertFindings,
  upsertInstallation,
  visibleRepos,
  type Db,
  type FindingInput,
} from "@sandchest/db";
import { migrate } from "@sandchest/db/migrate";
import type { Email } from "@sandchest/email";
import { storeAccess } from "@/server/access";
import { resetConfig } from "@/server/config";
import { setMailer } from "@/server/mailer";
import { resetLimits } from "@/server/rate-limit";
import { hashToken, inviteTeammate, joinTeam, parseInvitee } from "@/server/team";

/** Whether `person` may change acme's settings right now. */
const isAcmeAdmin = async (person: string) => !!(await orgForAdmin(database, person, ids.acme));
/** Where each of a person's admin roles comes from. */
const adminVia = async (person: string) => (await database.select().from(schema.orgAdmins)).filter((row) => row.userId === person).map((row) => row.via);

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest";
const NAME = `sandchest_team_test_${process.pid}`;
const BASE = "https://sandchest.test";

let admin: postgres.Sql | undefined;
let database: Db;
let available = true;
const sent: Email[] = [];

/** GitHub people: their id, login, and the emails GitHub lists for them. */
const PEOPLE = {
  alice: { id: 501, login: "alice", emails: [{ email: "alice@example.com", verified: true }] },
  bob: { id: 502, login: "bob", emails: [{ email: "bob@example.com", verified: true }] },
  carol: { id: 503, login: "carol", emails: [{ email: "carol@example.com", verified: true }, { email: "Carol@Work.Example", verified: true }] },
  dave: { id: 504, login: "dave", emails: [{ email: "dave@example.com", verified: true }, { email: "carol@unverified.example", verified: false }] },
  erin: { id: 505, login: "erin", emails: [{ email: "erin@example.com", verified: true }] },
};
type Person = keyof typeof PEOPLE;

/**
 * A fake GitHub API as one person's token sees it. `access` is what they can
 * reach through the App (installation 11 is acme, 12 is globex).
 */
function github(person: Person, access: Array<{ id: number; login: string; repos: Array<{ id: number; push?: boolean; admin?: boolean }>; orgAdmin?: boolean }> = []) {
  const me = PEOPLE[person];
  const fake = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(String(input));
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/user") return json({ id: me.id, login: me.login });
    if (url.pathname === "/user/emails") return json(me.emails.map((e) => ({ ...e, primary: false, visibility: null })));
    const user = /^\/users\/(.+)$/.exec(url.pathname);
    if (user) {
      const login = decodeURIComponent(user[1]!).toLowerCase();
      if (login === "acme") return json({ id: 100, login: "acme", type: "Organization" });
      const found = Object.values(PEOPLE).find((p) => p.login === login);
      return found ? json({ id: found.id, login: found.login, type: "User" }) : json({ message: "Not Found" }, 404);
    }
    if (url.pathname === "/user/installations") return json({ installations: access.map(({ id, login }) => ({ id, account: { id: id * 10, login, type: "Organization" }, suspended_at: null })) });
    const repos = /^\/user\/installations\/(\d+)\/repositories$/.exec(url.pathname);
    if (repos) return json({ repositories: access.find((i) => i.id === Number(repos[1]))!.repos.map((r) => ({ id: r.id, permissions: { admin: !!r.admin, push: !!r.push || !!r.admin, pull: true } })) });
    const membership = /^\/user\/memberships\/orgs\/(.+)$/.exec(url.pathname);
    if (membership) return access.find((i) => i.login === decodeURIComponent(membership[1]!))?.orgAdmin ? json({ state: "active", role: "admin" }) : json({ message: "Not Found" }, 404);
    return json({ message: `unexpected ${url.pathname}` }, 500);
  }) as typeof fetch;
  return { token: `token-${person}`, http: { fetch: fake, maxAttempts: 1 } };
}

let ids: Record<"acme" | "globex" | "api" | "secret" | "web" | "globexRepo" | Person, string> & { apiFinding: string; globexFinding: string };

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

/** Alice administers acme (api, secret, web); Bob can push to acme/api only; Erin administers globex. */
async function readGithubAccess() {
  await storeAccess(ids.alice, "a", github("alice", [{ id: 11, login: "acme", repos: [{ id: 1, admin: true }, { id: 2, push: true }, { id: 3, push: true }], orgAdmin: true }]).http);
  await storeAccess(ids.bob, "b", github("bob", [{ id: 11, login: "acme", repos: [{ id: 1, push: true }] }]).http);
  await storeAccess(ids.erin, "e", github("erin", [{ id: 12, login: "globex", repos: [{ id: 9, admin: true }], orgAdmin: true }]).http);
  for (const person of ["carol", "dave"] as const) await storeAccess(ids[person], person, github(person).http);
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
  Object.assign(process.env, { DATABASE_URL: url.toString(), GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "unused", GITHUB_WEBHOOK_SECRET: "unused", SANDCHEST_APP_URL: BASE });
  resetConfig();
  database = createDb(url.toString(), { max: 8 });
  await migrate(database);
  const { setServices } = await import("@/server/services");
  setServices({ db: database, github: {} as never });
  setMailer({ enabled: true, send: async (email) => void sent.push(email) });

  const acme = await upsertInstallation(database, 11, { githubAccountId: 110, githubLogin: "acme", type: "Organization" }, [
    { githubRepoId: 1, fullName: "acme/api", private: true, defaultBranch: "main" },
    { githubRepoId: 2, fullName: "acme/secret", private: true, defaultBranch: "main" },
    { githubRepoId: 3, fullName: "acme/web", private: true, defaultBranch: "main" },
  ]);
  const globex = await upsertInstallation(database, 12, { githubAccountId: 120, githubLogin: "globex", type: "Organization" }, [{ githubRepoId: 9, fullName: "globex/core", private: true, defaultBranch: "main" }]);
  const users: Record<string, string> = {};
  for (const [key, person] of Object.entries(PEOPLE)) {
    const [row] = await database.insert(schema.users).values({ name: key[0]!.toUpperCase() + key.slice(1), email: person.emails[0]!.email, login: person.login, githubUserId: person.id }).returning();
    users[key] = row!.id;
  }
  const repo = (full: string) => [...acme.repos, ...globex.repos].find((r) => r.fullName === full)!.id;
  const [scan] = await database.insert(schema.scans).values({ repoId: repo("acme/api"), orgId: acme.org.id, kind: "deep", status: "completed", trigger: "manual", headSha: "abc" }).returning();
  const [globexScan] = await database.insert(schema.scans).values({ repoId: repo("globex/core"), orgId: globex.org.id, kind: "deep", status: "completed", trigger: "manual", headSha: "abc" }).returning();
  const { ids: apiFindings } = await upsertFindings(database, repo("acme/api"), scan!, [finding("f1")]);
  const { ids: globexFindings } = await upsertFindings(database, repo("globex/core"), globexScan!, [finding("g1")]);
  ids = {
    acme: acme.org.id,
    globex: globex.org.id,
    api: repo("acme/api"),
    secret: repo("acme/secret"),
    web: repo("acme/web"),
    globexRepo: repo("globex/core"),
    ...(users as Record<Person, string>),
    apiFinding: apiFindings[0]!,
    globexFinding: globexFindings[0]!,
  };
  await readGithubAccess();
});

afterAll(async () => {
  setMailer(undefined);
  if (!available) return;
  await database.$client.end();
  await admin!.unsafe(`drop database if exists ${NAME} with (force)`);
  await admin!.end();
});

beforeEach(async () => {
  sent.length = 0;
  resetLimits();
  if (!available) return;
  // Each test starts from GitHub's access alone: no members, no invites.
  await database.delete(schema.orgInvites);
  await database.delete(schema.orgMembers);
  await database.$client`delete from permission_cache where via = 'invite'`;
  await database.$client`delete from org_admins where via = 'invite'`;
});

const tokenOf = (link: string) => link.slice(`${BASE}/invite/`.length);
const repoNames = async (user: string) => (await visibleRepos(database, user)).map((r) => r.fullName).sort();

/** Alice invites `invitee` to acme and returns the link's token. */
async function invite(invitee: string, by: Person = "alice", org: "acme" | "globex" = "acme"): Promise<string> {
  const outcome = await inviteTeammate(ids[by], { orgId: ids[org], invitee }, github(by));
  if (!outcome.ok) throw new Error(outcome.error);
  return tokenOf(outcome.link);
}

describe("what an admin can type", () => {
  test("emails and GitHub logins, nothing else", () => {
    expect(parseInvitee(" Carol@Example.com ")).toEqual({ email: "carol@example.com" });
    expect(parseInvitee("@carol")).toEqual({ login: "carol" });
    expect(parseInvitee("carol-b")).toEqual({ login: "carol-b" });
    for (const bad of ["", " ", "a b", "carol--b", "-carol", "carol-", "x".repeat(40), "<a>@b.c", "a@b", "a@@b.c", "a,b@c.d", `${"a".repeat(250)}@b.cd`, "carol\n@x.y"]) {
      expect(parseInvitee(bad)).toBeUndefined();
    }
  });
});

describe("inviting", () => {
  test.skipIf(!available)("an admin invites an email address: one row, only the token's hash stored, one email with the link", async () => {
    const outcome = await inviteTeammate(ids.alice, { orgId: ids.acme, invitee: "Carol@Work.Example" }, github("alice"));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.emailed).toBe(true);
    expect(outcome.who).toBe("carol@work.example");
    const token = tokenOf(outcome.link);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await database.select().from(schema.orgInvites);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.email).toBe("carol@work.example");
    expect(rows[0]!.tokenHash).toBe(hashToken(token));
    expect(rows[0]!.tokenHash).not.toContain(token);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual(["carol@work.example"]);
    expect(sent[0]!.subject).toBe("@alice invited you to acme on Sandchest");
    expect(sent[0]!.html).toContain(`${BASE}/invite/${token}`);
  });

  test.skipIf(!available)("an admin invites a GitHub account: no email, the link is shown once", async () => {
    const outcome = await inviteTeammate(ids.alice, { orgId: ids.acme, invitee: "@Carol" }, github("alice"));
    expect(outcome).toMatchObject({ ok: true, who: "@carol", emailed: false });
    expect(sent).toHaveLength(0);
    const [row] = await database.select().from(schema.orgInvites);
    expect(row).toMatchObject({ githubUserId: 503, githubLogin: "carol", email: null });
  });

  test.skipIf(!available)("only real GitHub people can be invited by login", async () => {
    expect(await inviteTeammate(ids.alice, { orgId: ids.acme, invitee: "nobody-here" }, github("alice"))).toMatchObject({ ok: false });
    expect(await inviteTeammate(ids.alice, { orgId: ids.acme, invitee: "acme" }, github("alice"))).toMatchObject({ ok: false });
    expect(await database.select().from(schema.orgInvites)).toHaveLength(0);
  });

  test.skipIf(!available)("someone who can push but isn't an admin can't invite, nor can another org's admin", async () => {
    expect(await inviteTeammate(ids.bob, { orgId: ids.acme, invitee: "carol@example.com" }, github("bob"))).toMatchObject({ ok: false, error: expect.stringContaining("admin") });
    expect(await inviteTeammate(ids.erin, { orgId: ids.acme, invitee: "carol@example.com" }, github("erin"))).toMatchObject({ ok: false });
    expect(await inviteTeammate(ids.erin, { orgId: ids.acme, invitee: "@carol" }, github("erin"))).toMatchObject({ ok: false });
    expect(await database.select().from(schema.orgInvites)).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  test.skipIf(!available)("without email set up, the invite is made and the link handed to the admin", async () => {
    setMailer({ enabled: false, send: async () => void sent.push({ to: ["never"], subject: "", html: "", text: "" }) });
    try {
      const outcome = await inviteTeammate(ids.alice, { orgId: ids.acme, invitee: "carol@example.com" }, github("alice"));
      expect(outcome).toMatchObject({ ok: true, emailed: false });
      expect(sent).toHaveLength(0);
    } finally {
      setMailer({ enabled: true, send: async (email) => void sent.push(email) });
    }
  });

  test.skipIf(!available)("an email that fails to send still leaves the invite and its link", async () => {
    setMailer({ enabled: true, send: async () => Promise.reject(new Error("smtp down for carol@example.com")) });
    try {
      const outcome = await inviteTeammate(ids.alice, { orgId: ids.acme, invitee: "carol@example.com" }, github("alice"));
      expect(outcome).toMatchObject({ ok: true, emailed: false });
    } finally {
      setMailer({ enabled: true, send: async (email) => void sent.push(email) });
    }
  });

  test.skipIf(!available)("inviting the same person again replaces the pending invite: the old link stops working", async () => {
    const first = await invite("carol@example.com");
    const second = await invite("carol@example.com");
    expect((await inviteByTokenHash(database, hashToken(first)))?.pending).toBe(false);
    expect((await joinTeam(ids.carol, first, github("carol"))).ok).toBe(false);
    expect(await joinTeam(ids.carol, second, github("carol"))).toMatchObject({ ok: true });
  });

  test.skipIf(!available)("sending again is the same: only the newest link works", async () => {
    await invite("@carol");
    const [pending] = await database.select().from(schema.orgInvites);
    const again = await inviteTeammate(ids.alice, { resend: pending!.id }, github("alice"));
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(await joinTeam(ids.carol, tokenOf(again.link), github("carol"))).toMatchObject({ ok: true });
    // Only an admin of the invite's org can send it again.
    const another = (await database.select().from(schema.orgInvites)).find((row) => row.id === again.inviteId);
    expect(await inviteTeammate(ids.bob, { resend: another!.id }, github("bob"))).toMatchObject({ ok: false });
    expect(await inviteTeammate(ids.erin, { resend: another!.id }, github("erin"))).toMatchObject({ ok: false });
  });

  test.skipIf(!available)("someone already on the team isn't invited again", async () => {
    await joinTeam(ids.carol, await invite("@carol"), github("carol"));
    expect(await inviteTeammate(ids.alice, { orgId: ids.acme, invitee: "@carol" }, github("alice"))).toMatchObject({ ok: false, error: expect.stringContaining("already") });
    expect(await inviteTeammate(ids.alice, { orgId: ids.acme, invitee: "carol@example.com" }, github("alice"))).toMatchObject({ ok: false, error: expect.stringContaining("already") });
  });

  test.skipIf(!available)("one person can't be sent invite after invite: a few an hour, then refused", async () => {
    for (let i = 0; i < INVITES_PER_INVITEE_HOUR; i++) await invite("carol@example.com");
    expect(await inviteTeammate(ids.alice, { orgId: ids.acme, invitee: "carol@example.com" }, github("alice"))).toMatchObject({ ok: false, error: expect.stringContaining("lot of invites") });
    expect(sent).toHaveLength(INVITES_PER_INVITEE_HOUR);
  });

  test.skipIf(!available)("an admin can't invite themselves", async () => {
    expect(await inviteTeammate(ids.alice, { orgId: ids.acme, invitee: "@alice" }, github("alice"))).toMatchObject({ ok: false, error: expect.stringContaining("you") });
    expect(await inviteTeammate(ids.alice, { orgId: ids.acme, invitee: "ALICE@example.com" }, github("alice"))).toMatchObject({ ok: false });
    expect(await database.select().from(schema.orgInvites)).toHaveLength(0);
  });

  test.skipIf(!available)("one address gets a few invites a day from all orgs together, so the mailer can't be aimed at a stranger", async () => {
    const now = new Date();
    for (let i = 0; i < INVITES_PER_ADDRESS_DAY; i++) {
      const org = i % 2 === 0 ? { userId: ids.alice, orgId: ids.acme } : { userId: ids.erin, orgId: ids.globex };
      expect((await createInvite(database, { ...org, invitee: { email: "stranger@example.com" }, tokenHash: `s${i}`, now })).ok).toBe(true);
    }
    expect(await createInvite(database, { userId: ids.erin, orgId: ids.globex, invitee: { email: "stranger@example.com" }, tokenHash: "s-more", now })).toEqual({ ok: false, reason: "limited" });
  });

  test.skipIf(!available)("a day's sends per admin are capped in the database, whatever instance takes them", async () => {
    const now = new Date();
    for (let i = 0; i < 50; i++) {
      const result = await createInvite(database, { userId: ids.alice, orgId: ids.acme, invitee: { email: `p${i}@example.com` }, tokenHash: `h${i}`, now });
      expect(result.ok).toBe(true);
    }
    expect(await createInvite(database, { userId: ids.alice, orgId: ids.acme, invitee: { email: "one-more@example.com" }, tokenHash: "h-more", now })).toEqual({ ok: false, reason: "limited" });
  });

  test.skipIf(!available)("concurrent invites to one person leave exactly one pending", async () => {
    const results = await Promise.all(Array.from({ length: 3 }, (_, i) => createInvite(database, { userId: ids.alice, orgId: ids.acme, invitee: { email: "race@example.com" }, tokenHash: `race-${i}` })));
    expect(results.every((r) => r.ok)).toBe(true);
    const pending = (await database.select().from(schema.orgInvites)).filter((row) => row.email === "race@example.com");
    expect(pending.filter((row) => !row.revokedAt && !row.acceptedAt)).toHaveLength(1);
  });

  test.skipIf(!available)("only an admin of the invite's org revokes it", async () => {
    await invite("carol@example.com");
    const [row] = await database.select().from(schema.orgInvites);
    expect(await revokeInvite(database, ids.bob, row!.id)).toBeUndefined();
    expect(await revokeInvite(database, ids.erin, row!.id)).toBeUndefined();
    expect(await revokeInvite(database, ids.alice, row!.id)).toBe(ids.acme);
    expect(await revokeInvite(database, ids.alice, row!.id)).toBeUndefined();
  });
});

describe("joining", () => {
  test.skipIf(!available)("the invited person joins and sees every repo of the org, and nothing of another", async () => {
    expect(await repoNames(ids.carol)).toEqual([]);
    const token = await invite("carol@work.example");
    const joined = await joinTeam(ids.carol, token, github("carol"));
    expect(joined).toEqual({ ok: true, orgId: ids.acme, orgLogin: "acme", role: "member" });
    expect(await repoNames(ids.carol)).toEqual(["acme/api", "acme/secret", "acme/web"]);
    expect((await dashboardRepos(database, ids.carol)).map((r) => r.fullName).sort()).toEqual(["acme/api", "acme/secret", "acme/web"]);
    expect(await findingForUser(database, ids.carol, ids.apiFinding)).toBeDefined();
    expect(await findingForUser(database, ids.carol, ids.globexFinding)).toBeUndefined();
    expect(await repoForUser(database, ids.carol, ids.globexRepo)).toBeUndefined();
    expect([...(await memberOrgIds(database, ids.carol))]).toEqual([ids.acme]);
    // A member is not an admin: no settings, no billing.
    expect(await updateOrgSettings(database, ids.carol, ids.acme, { checkThreshold: "low" })).toBe(false);
    // They hear about findings like anyone with access.
    expect(await notificationRecipients(database, ids.secret)).toContain("carol@example.com");
  });

  test.skipIf(!available)("a link works once", async () => {
    const token = await invite("@carol");
    expect((await joinTeam(ids.carol, token, github("carol"))).ok).toBe(true);
    expect(await joinTeam(ids.carol, token, github("carol"))).toMatchObject({ ok: false, reason: "not_found" });
  });

  test.skipIf(!available)("someone else holding the link can't use it: the email must be verified on their GitHub", async () => {
    const token = await invite("carol@example.com");
    expect(await joinTeam(ids.dave, token, github("dave"))).toMatchObject({ ok: false, reason: "wrong_person" });
    expect(await joinTeam(ids.bob, token, github("bob"))).toMatchObject({ ok: false, reason: "wrong_person" });
    expect(await repoNames(ids.dave)).toEqual([]);
    expect(await repoNames(ids.bob)).toEqual(["acme/api"]);
    // Refusals leave the invite for its person.
    expect((await joinTeam(ids.carol, token, github("carol"))).ok).toBe(true);
  });

  test.skipIf(!available)("an address GitHub lists but hasn't verified doesn't count", async () => {
    const token = await invite("carol@unverified.example");
    expect(await joinTeam(ids.dave, token, github("dave"))).toMatchObject({ ok: false, reason: "wrong_person" });
  });

  test.skipIf(!available)("a GitHub invite is for that account's id: another login can't use it", async () => {
    const token = await invite("@carol");
    expect(await joinTeam(ids.dave, token, github("dave"))).toMatchObject({ ok: false, reason: "wrong_person" });
    // A user row claiming Carol's login means nothing: GitHub says who the token is.
    await database.$client`update users set login = 'carol' where id = ${ids.dave}`;
    expect(await joinTeam(ids.dave, token, github("dave"))).toMatchObject({ ok: false, reason: "wrong_person" });
    await database.$client`update users set login = 'dave' where id = ${ids.dave}`;
  });

  test.skipIf(!available)("expired, revoked and made-up links don't work", async () => {
    const past = new Date(Date.now() - 8 * 86_400_000);
    await createInvite(database, { userId: ids.alice, orgId: ids.acme, invitee: { githubUserId: 503, githubLogin: "carol" }, tokenHash: hashToken("e".repeat(43)), now: past });
    expect(await joinTeam(ids.carol, "e".repeat(43), github("carol"))).toMatchObject({ ok: false, reason: "expired" });

    const revoked = await invite("@dave");
    const row = (await database.select().from(schema.orgInvites)).find((invite) => invite.githubUserId === 504);
    await revokeInvite(database, ids.alice, row!.id);
    expect(await joinTeam(ids.dave, revoked, github("dave"))).toMatchObject({ ok: false, reason: "not_found" });

    for (const fake of ["x".repeat(43), "short", "../../etc/passwd", `${"a".repeat(42)}=`, ""]) {
      expect(await joinTeam(ids.carol, fake, github("carol"))).toMatchObject({ ok: false, reason: "not_found" });
    }
    expect(await repoNames(ids.carol)).toEqual([]);
    expect(await repoNames(ids.dave)).toEqual([]);
  });

  test.skipIf(!available)("an org uninstalled after the invite has nothing to join", async () => {
    const token = await invite("@carol");
    await removeInstallation(database, 11);
    try {
      expect(await joinTeam(ids.carol, token, github("carol"))).toMatchObject({ ok: false, reason: "no_installation" });
    } finally {
      await upsertInstallation(database, 11, { githubAccountId: 110, githubLogin: "acme", type: "Organization" }, [
        { githubRepoId: 1, fullName: "acme/api", private: true, defaultBranch: "main" },
        { githubRepoId: 2, fullName: "acme/secret", private: true, defaultBranch: "main" },
        { githubRepoId: 3, fullName: "acme/web", private: true, defaultBranch: "main" },
      ]);
    }
  });

  test.skipIf(!available)("an invite stops working once whoever sent it isn't an admin anymore", async () => {
    const token = await invite("@carol");
    await storeAccess(ids.alice, "a", github("alice", [{ id: 11, login: "acme", repos: [{ id: 1, push: true }] }]).http);
    try {
      expect(await joinTeam(ids.carol, token, github("carol"))).toMatchObject({ ok: false, reason: "inviter_gone" });
      expect(await repoNames(ids.carol)).toEqual([]);
    } finally {
      await readGithubAccess();
    }
    expect((await joinTeam(ids.carol, token, github("carol"))).ok).toBe(true);
  });

  test.skipIf(!available)("the same link pressed twice at once joins once", async () => {
    const token = await invite("@carol");
    const tokenHash = hashToken(token);
    const results = await Promise.all(Array.from({ length: 4 }, () => acceptInvite(database, { userId: ids.carol, tokenHash, identity: { githubUserId: 503, verifiedEmails: [] } })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await database.select().from(schema.orgMembers)).toHaveLength(1);
  });

  test.skipIf(!available)("GitHub not answering refuses, and leaves the invite", async () => {
    const token = await invite("@carol");
    const down = { token: "t", http: { fetch: (async () => new Response("{}", { status: 502 })) as unknown as typeof fetch, maxAttempts: 1 } };
    expect(await joinTeam(ids.carol, token, down)).toMatchObject({ ok: false, reason: "github_error" });
    expect((await joinTeam(ids.carol, token, github("carol"))).ok).toBe(true);
  });
});

describe("staying and leaving", () => {
  test.skipIf(!available)("reading access from GitHub again keeps what the invite gives, and repos added since show up", async () => {
    await joinTeam(ids.bob, await invite("@bob"), github("bob"));
    expect(await repoNames(ids.bob)).toEqual(["acme/api", "acme/secret", "acme/web"]);
    await readGithubAccess();
    expect(await repoNames(ids.bob)).toEqual(["acme/api", "acme/secret", "acme/web"]);
    // GitHub's grant wins where both give access, so it survives leaving.
    const rows = (await database.select().from(schema.permissionCache)).filter((row) => row.userId === ids.bob);
    expect(rows.find((row) => row.repoId === ids.api)?.via).toBe("github");

    const { repos } = await upsertInstallation(database, 11, { githubAccountId: 110, githubLogin: "acme", type: "Organization" }, [{ githubRepoId: 4, fullName: "acme/new", private: true, defaultBranch: "main" }]);
    await readGithubAccess();
    expect(await repoNames(ids.bob)).toContain("acme/new");
    await database.$client`update repos set enabled = false where id = ${repos[0]!.id}`;
  });

  test.skipIf(!available)("removing a member takes the invite's access away at once, and leaves GitHub's", async () => {
    await joinTeam(ids.bob, await invite("@bob"), github("bob"));
    await joinTeam(ids.carol, await invite("@carol"), github("carol"));
    expect(await removeMember(database, ids.bob, ids.acme, ids.carol)).toBe(false);
    expect(await removeMember(database, ids.erin, ids.acme, ids.carol)).toBe(false);
    expect(await repoNames(ids.carol)).toHaveLength(3);

    expect(await removeMember(database, ids.alice, ids.acme, ids.carol)).toBe(true);
    expect(await removeMember(database, ids.alice, ids.acme, ids.bob)).toBe(true);
    expect(await repoNames(ids.carol)).toEqual([]);
    expect(await repoNames(ids.bob)).toEqual(["acme/api"]);
    expect(await findingForUser(database, ids.carol, ids.apiFinding)).toBeUndefined();
    // And it stays gone after access is read again.
    await readGithubAccess();
    expect(await repoNames(ids.carol)).toEqual([]);
    // Admins aren't members: there's nothing to remove.
    expect(await removeMember(database, ids.alice, ids.acme, ids.alice)).toBe(false);
    expect(await repoNames(ids.alice)).toHaveLength(3);
  });

  test.skipIf(!available)("a member leaves on their own", async () => {
    await joinTeam(ids.carol, await invite("@carol"), github("carol"));
    expect(await leaveOrg(database, ids.carol, ids.globex)).toBe(false);
    expect(await leaveOrg(database, ids.carol, ids.acme)).toBe(true);
    expect(await repoNames(ids.carol)).toEqual([]);
  });

  test.skipIf(!available)("removal racing a read of access from GitHub never leaves access behind", async () => {
    for (let round = 0; round < 5; round++) {
      await joinTeam(ids.carol, await invite("@carol"), github("carol"));
      resetLimits();
      await Promise.all([storeAccess(ids.carol, "c", github("carol").http), removeMember(database, ids.alice, ids.acme, ids.carol), storeAccess(ids.carol, "c", github("carol").http)]);
      expect(await repoNames(ids.carol)).toEqual([]);
      await database.delete(schema.orgInvites);
    }
  });

  test.skipIf(!available)("an uninstalled org's members keep nothing when access is read again", async () => {
    await joinTeam(ids.carol, await invite("@carol"), github("carol"));
    await removeInstallation(database, 11);
    try {
      await storeAccess(ids.carol, "c", github("carol").http);
      expect(await repoNames(ids.carol)).toEqual([]);
    } finally {
      await upsertInstallation(database, 11, { githubAccountId: 110, githubLogin: "acme", type: "Organization" }, [
        { githubRepoId: 1, fullName: "acme/api", private: true, defaultBranch: "main" },
        { githubRepoId: 2, fullName: "acme/secret", private: true, defaultBranch: "main" },
        { githubRepoId: 3, fullName: "acme/web", private: true, defaultBranch: "main" },
      ]);
      await readGithubAccess();
    }
  });
});

describe("the team as admins see it", () => {
  test.skipIf(!available)("everyone with access and how they got it, and pending invites, for admins only", async () => {
    await joinTeam(ids.carol, await invite("@carol"), github("carol"));
    await invite("dave@example.com");
    const teams = await adminTeams(database, ids.alice);
    const acme = teams.get(ids.acme)!;
    const by = (login: string) => acme.people.find((p) => p.login === login);
    expect(by("alice")).toMatchObject({ admin: true, member: false, github: true });
    expect(by("bob")).toMatchObject({ admin: false, member: false, github: true });
    expect(by("carol")).toMatchObject({ admin: false, member: true, github: false });
    expect(by("erin")).toBeUndefined();
    expect(acme.invites.map((i) => i.email)).toEqual(["dave@example.com"]);
    expect(teams.has(ids.globex)).toBe(false);
    // Not an admin: no teams at all.
    expect((await adminTeams(database, ids.bob)).size).toBe(0);
    expect((await adminTeams(database, ids.carol)).size).toBe(0);
    expect([...(await adminTeams(database, ids.erin)).keys()]).toEqual([ids.globex]);
  });
});

describe("admins and members", () => {
  test.skipIf(!available)("an invite as an admin gives the admin role: settings, billing and the team", async () => {
    const outcome = await inviteTeammate(ids.alice, { orgId: ids.acme, invitee: "@carol", role: "admin" }, github("alice"));
    expect(outcome).toMatchObject({ ok: true, role: "admin" });
    if (!outcome.ok) return;
    expect(await joinTeam(ids.carol, tokenOf(outcome.link), github("carol"))).toMatchObject({ ok: true, role: "admin" });
    expect(await isAcmeAdmin(ids.carol)).toBe(true);
    expect(await adminVia(ids.carol)).toEqual(["invite"]);
    expect(await updateOrgSettings(database, ids.carol, ids.acme, { checkThreshold: "low" })).toBe(true);
    await updateOrgSettings(database, ids.alice, ids.acme, { checkThreshold: "high" });
    expect((await adminTeams(database, ids.carol)).has(ids.acme)).toBe(true);
    // They can invite and manage people in turn.
    const next = await inviteTeammate(ids.carol, { orgId: ids.acme, invitee: "@dave" }, github("carol"));
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect((await joinTeam(ids.dave, tokenOf(next.link), github("dave"))).ok).toBe(true);
    expect(await setMemberRole(database, ids.carol, ids.acme, ids.dave, "admin")).toBe(true);
    expect(await removeMember(database, ids.carol, ids.acme, ids.dave)).toBe(true);
    // Billing and finding emails reach them like any admin.
    expect((await orgAdminContacts(database, ids.acme)).find((a) => a.userId === ids.carol)).toMatchObject({ fresh: true });
    // Still an admin after GitHub is read again, and nothing of globex.
    await readGithubAccess();
    expect(await isAcmeAdmin(ids.carol)).toBe(true);
    expect(!!(await orgForAdmin(database, ids.carol, ids.globex))).toBe(false);
  });

  test.skipIf(!available)("only an admin of the org changes roles: not members, not pushers, not another org's admin, not yourself as a member", async () => {
    await joinTeam(ids.carol, await invite("@carol"), github("carol"));
    await joinTeam(ids.dave, await invite("@dave"), github("dave"));
    expect(await setMemberRole(database, ids.carol, ids.acme, ids.carol, "admin")).toBe(false);
    expect(await setMemberRole(database, ids.carol, ids.acme, ids.dave, "admin")).toBe(false);
    expect(await setMemberRole(database, ids.bob, ids.acme, ids.carol, "admin")).toBe(false);
    expect(await setMemberRole(database, ids.erin, ids.acme, ids.carol, "admin")).toBe(false);
    expect(await isAcmeAdmin(ids.carol)).toBe(false);
    expect(await isAcmeAdmin(ids.dave)).toBe(false);
    // Nobody invited, nothing to change.
    expect(await setMemberRole(database, ids.alice, ids.acme, ids.erin, "admin")).toBe(false);
    expect(await isAcmeAdmin(ids.erin)).toBe(false);
  });

  test.skipIf(!available)("making someone a member, or removing them, takes the admin role away at once and for good", async () => {
    await joinTeam(ids.carol, await invite("@carol", "alice"), github("carol"));
    expect(await setMemberRole(database, ids.alice, ids.acme, ids.carol, "admin")).toBe(true);
    expect(await isAcmeAdmin(ids.carol)).toBe(true);
    expect(await setMemberRole(database, ids.alice, ids.acme, ids.carol, "member")).toBe(true);
    expect(await isAcmeAdmin(ids.carol)).toBe(false);
    expect(await repoNames(ids.carol)).toHaveLength(3);
    await readGithubAccess();
    expect(await isAcmeAdmin(ids.carol)).toBe(false);

    expect(await setMemberRole(database, ids.alice, ids.acme, ids.carol, "admin")).toBe(true);
    expect(await removeMember(database, ids.alice, ids.acme, ids.carol)).toBe(true);
    expect(await isAcmeAdmin(ids.carol)).toBe(false);
    expect(await repoNames(ids.carol)).toEqual([]);
    expect((await orgAdminContacts(database, ids.acme)).some((a) => a.userId === ids.carol)).toBe(false);
    await readGithubAccess();
    expect(await isAcmeAdmin(ids.carol)).toBe(false);
  });

  test.skipIf(!available)("leaving as an admin takes the role too", async () => {
    await joinTeam(ids.carol, await invite("@carol"), github("carol"));
    await setMemberRole(database, ids.alice, ids.acme, ids.carol, "admin");
    expect(await leaveOrg(database, ids.carol, ids.acme)).toBe(true);
    expect(await isAcmeAdmin(ids.carol)).toBe(false);
  });

  test.skipIf(!available)("GitHub's admin role never goes, whatever the invite says", async () => {
    // Alice is acme's admin on GitHub, and also joins by invite (from Erin's side of things: someone added her).
    expect(await adminVia(ids.alice)).toEqual(["github"]);
    await database.$client`insert into org_members (org_id, user_id, role) values (${ids.acme}, ${ids.alice}, 'admin')`;
    await readGithubAccess();
    expect(await adminVia(ids.alice)).toEqual(["github"]);
    expect(await setMemberRole(database, ids.alice, ids.acme, ids.alice, "member")).toBe(true);
    expect(await isAcmeAdmin(ids.alice)).toBe(true);
    expect(await removeMember(database, ids.alice, ids.acme, ids.alice)).toBe(true);
    expect(await isAcmeAdmin(ids.alice)).toBe(true);
    expect(await repoNames(ids.alice)).toHaveLength(3);
  });

  test.skipIf(!available)("an invite sent again keeps its role; an invite from an admin who was made a member stops working", async () => {
    await joinTeam(ids.carol, await invite("@carol"), github("carol"));
    await setMemberRole(database, ids.alice, ids.acme, ids.carol, "admin");
    const sent = await inviteTeammate(ids.carol, { orgId: ids.acme, invitee: "@dave", role: "admin" }, github("carol"));
    expect(sent).toMatchObject({ ok: true, role: "admin" });
    const [row] = (await database.select().from(schema.orgInvites)).filter((invite) => invite.githubUserId === 504 && !invite.revokedAt);
    const again = await inviteTeammate(ids.carol, { resend: row!.id }, github("carol"));
    expect(again).toMatchObject({ ok: true, role: "admin" });
    if (!again.ok) return;
    await setMemberRole(database, ids.alice, ids.acme, ids.carol, "member");
    expect(await joinTeam(ids.dave, tokenOf(again.link), github("dave"))).toMatchObject({ ok: false, reason: "inviter_gone" });
    expect(await isAcmeAdmin(ids.dave)).toBe(false);
  });

  test.skipIf(!available)("a member can't invite, as a member or an admin", async () => {
    await joinTeam(ids.carol, await invite("@carol"), github("carol"));
    for (const role of ["member", "admin"] as const) {
      expect(await inviteTeammate(ids.carol, { orgId: ids.acme, invitee: "@dave", role }, github("carol"))).toMatchObject({ ok: false });
    }
    expect((await database.select().from(schema.orgInvites)).filter((invite) => invite.githubUserId === 504)).toHaveLength(0);
  });
});
