/**
 * Billing and operational emails (SPEC §14) against a real Postgres, with
 * Autumn and the mailer faked: credits low and exhausted (each crossing
 * once, re-armed when credits return), auto top-up results from Autumn's
 * signed webhooks, and a scan paused by the model provider's quota.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { AutumnError, signWebhook } from "@sandchest/billing";
import { createDb, orgAdminContacts, orgBillingRow, saveOrgBilling, schema, upsertInstallation, type Db } from "@sandchest/db";
import { migrate } from "@sandchest/db/migrate";
import type { Email, Mailer } from "@sandchest/email";
import type { GitHubApp } from "@sandchest/github";
import { POST as autumnWebhook } from "@/app/api/autumn/webhooks/route";
import { money } from "@/server/autumn-webhooks";
import { applyAutoTopUp, pageBilling, reserveScan, setAutumn, syncBilling } from "@/server/billing";
import { describeError } from "@/server/log";
import { resetConfig } from "@/server/config";
import { setMailer } from "@/server/mailer";
import {
  forgetAdminChecks,
  noticeAutoTopUp,
  noticeAutoTopUpFailed,
  noticeCredits,
  noticeScanPaused,
  rememberAdminCheck,
  rememberedAdminChecks,
  type PausedScan,
} from "@/server/notices";
import { setServices } from "@/server/services";
import { setScanStarter } from "@/server/start";
import { FakeAutumn } from "./fake-autumn";

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest";
const NAME = `sandchest_billing_emails_test_${process.pid}`;
const WEBHOOK_SECRET = `whsec_${Buffer.from("billing-emails-test-signing-key!").toString("base64")}`;

let admin: postgres.Sql | undefined;
let database: Db;
let available = true;

const sent: Email[] = [];
const recordingMailer: Mailer = { enabled: true, send: async (email) => void sent.push(email) };
const autumn = new FakeAutumn();

/** GitHub's org memberships, by "org/login": who holds that username now, and their role. */
const githubMembers = new Map<string, { userId: number; role: string }>();
const githubAsked: string[] = [];
let githubDown = false;
/** Runs while GitHub is being asked, to change things in between. */
let whileAsking: (() => Promise<void>) | undefined;
const fakeGithub = {
  installation: (installationId: number) => ({
    orgMembership: async (org: string, login: string) => {
      githubAsked.push(`${installationId}:${org}/${login}`);
      if (whileAsking) await whileAsking();
      if (githubDown) throw new Error("GitHub 502: Bad Gateway");
      const member = githubMembers.get(`${org}/${login}`);
      return member ? { userId: member.userId, state: "active", role: member.role } : null;
    },
  }),
} as unknown as GitHubApp;
const started: string[] = [];
let acme: { id: string; githubLogin: string };
let repoId: string;
let lock = 0;

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
    SANDCHEST_APP_URL: "https://sandchest.test",
    AUTUMN_WEBHOOK_SECRET: WEBHOOK_SECRET,
  });
  resetConfig();
  database = createDb(url.toString(), { max: 10 });
  await migrate(database);
  setServices({ db: database, mailer: recordingMailer, github: fakeGithub });
  setAutumn(autumn);
  setScanStarter(async (id) => void started.push(id));

  const { org, repos } = await upsertInstallation(database, 601, { githubAccountId: 6100, githubLogin: "acme", type: "Organization" }, [
    { githubRepoId: 61, fullName: "acme/api", private: true, defaultBranch: "main" },
  ]);
  acme = { id: org.id, githubLogin: "acme" };
  repoId = repos[0]!.id;

  // Who could hear about acme's billing.
  const user = async (name: string, email: string) => (await database.insert(schema.users).values({ name, email, login: name }).returning())[0]!;
  const alice = await user("alice", "alice@example.com");
  const bob = await user("bob", "602+bob@users.noreply.github.com");
  const carol = await user("carol", "carol@example.com");
  const dave = await user("dave", "dave@example.com");
  await database.insert(schema.orgAdmins).values([
    { userId: alice.id, orgId: org.id },
    // An admin with only GitHub's no-reply placeholder.
    { userId: bob.id, orgId: org.id },
    // An admin GitHub has not confirmed for over 30 days.
    { userId: carol.id, orgId: org.id, checkedAt: new Date(Date.now() - 40 * 86_400_000) },
  ]);
  // Push access, but not an admin.
  await database.insert(schema.permissionCache).values({ userId: dave.id, repoId, permission: "write" });

  // Acme buys Lockbox: 6,000 credits, nothing to say yet.
  await autumn.attach({ customerId: acme.id, planId: "lockbox", successUrl: "" });
  await syncBilling(acme);
});

afterAll(async () => {
  setAutumn(undefined);
  setScanStarter(undefined);
  setMailer(undefined);
  delete process.env.AUTUMN_WEBHOOK_SECRET;
  resetConfig();
  if (!available) return;
  await database.$client.end();
  await admin!.unsafe(`drop database if exists ${NAME} with (force)`);
  await admin!.end();
});

/** Holds credits the way a paid scan does. */
const reserve = (credits: number) => {
  tick();
  return reserveScan(`00000000-0000-4000-8000-${String(++lock).padStart(12, "0")}`, acme, credits, false);
};
/**
 * Waits for the next millisecond. Two balances in the same millisecond tie, and a tie is stale, so each
 * step that observes a balance after another one waits for this first, the way real scans are apart.
 */
function tick(): void {
  const start = Date.now();
  while (Date.now() === start) {
    // spin: less than a millisecond
  }
}
/** Reads the org from Autumn in a later millisecond than whatever came before. */
const sync = (org = acme) => {
  tick();
  return syncBilling(org);
};
const level = async () => (await orgBillingRow(database, acme.id))!.creditLevel;
const subjects = () => sent.map((email) => email.subject);
/**
 * Who hears about acme's billing: Alice, the admin GitHub confirmed recently. Not Carol, whom it last
 * confirmed 40 days ago (she may have left), Bob (a no-reply placeholder) or Dave (not an admin).
 */
const ADMINS = ["alice@example.com"];
/** A balance seen just now. */
const now = () => {
  tick();
  const at = new Date();
  return { from: at, to: at };
};
/** Drizzle's client takes JSON as a string cast to jsonb (FINDINGS: not `sql.json`). */
async function setSettings(settings: Record<string, unknown>): Promise<void> {
  await database.$client`update orgs set settings = ${JSON.stringify(settings)}::jsonb where id = ${acme.id}`;
  const org = await database.query.orgs.findFirst({ where: (orgs, { eq }) => eq(orgs.id, acme.id) });
  expect(org!.settings).toEqual(settings as never);
}
function drain(): Email[] {
  return sent.splice(0, sent.length);
}

/** A delivery the way Svix sends it: signed over id, timestamp and the exact body. */
function delivery(payload: unknown, options: { id?: string; at?: number; secret?: string; body?: string } = {}): Request {
  const body = options.body ?? JSON.stringify(payload);
  const id = options.id ?? `msg_${crypto.randomUUID()}`;
  const timestamp = String(Math.floor((options.at ?? Date.now()) / 1000));
  return new Request("https://sandchest.test/api/autumn/webhooks", {
    method: "POST",
    headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": timestamp, "svix-signature": signWebhook(options.secret ?? WEBHOOK_SECRET, id, timestamp, body) },
    body,
  });
}

const toppedUp = (invoice: string, balanceAfter: number, customer = acme.id) => ({
  type: "billing.auto_topup_succeeded",
  id: `evt_auto_topup_${invoice}`,
  occurred_at: Date.now(),
  data: { customer_id: customer, feature_id: "credits", quantity_granted: 2_500, threshold: 1_500, balance_after: balanceAfter, invoice_mode: false, invoice: { stripe_id: invoice, status: "paid", total: 1000, currency: "usd", hosted_invoice_url: null } },
});

const topUpFailed = (reason: string, balance: number | null = 800) => ({
  type: "billing.auto_topup_failed",
  id: `evt_auto_topup_failed_${crypto.randomUUID()}`,
  occurred_at: Date.now(),
  data: { customer_id: acme.id, feature_id: "credits", reason, quantity: 2_500, threshold: 1_500, balance, invoice_mode: false, error: { code: "card_declined", message: "Your card was declined.", type: "card_error", decline_code: "generic_decline" } },
});

describe.skipIf(!available)("billing emails", () => {
  test("admins GitHub confirmed recently are preferred over stale ones, without asking GitHub", async () => {
    const contacts = await orgAdminContacts(database, acme.id);
    expect(contacts.map((admin) => [admin.email, admin.fresh]).sort()).toEqual([
      ["alice@example.com", true],
      ["carol@example.com", false],
    ]);
    await noticeCredits(acme, { planId: "lockbox", credits: 300, creditsResetAt: null, autoTopUp: null }, now());
    expect(sent.map((email) => email.to)).toEqual([ADMINS]);
    expect(githubAsked).toEqual([]);
    drain();
    await noticeCredits(acme, { planId: "lockbox", credits: 6_000, creditsResetAt: null, autoTopUp: null }, now());
    expect(await level()).toBe(0);
  });

  test("low: once when credits cross below the plan's line, not again while they stay low", async () => {
    autumn.get(acme.id).credits = 600;
    await reserve(100); // 500: the low line, still fine
    expect(sent).toHaveLength(0);
    await reserve(100); // 400
    expect(subjects()).toEqual(["400 credits left on acme"]);
    expect([...sent[0]!.to].sort()).toEqual(ADMINS);
    expect(sent[0]!.html).toContain("https://sandchest.test/dashboard/settings/billing?utm_source=email&amp;utm_medium=credits_low");
    expect(sent[0]!.text).toContain("come back on 1 Jan 2030");
    await reserve(100);
    await sync();
    expect(sent).toHaveLength(1);
    expect(await level()).toBe(1);
    drain();
  });

  test("exhausted: once when nothing is left, not again on refusals or reads", async () => {
    autumn.get(acme.id).credits = 200;
    await reserve(200);
    expect(subjects()).toEqual(["Out of credits on acme"]);
    expect(sent[0]!.text).toContain("Top up to keep scanning");
    expect(await reserve(100)).toMatchObject({ ok: false, reason: "out_of_credits" });
    await sync();
    expect(sent).toHaveLength(1);
    expect(await level()).toBe(2);
    drain();
  });

  test("credits coming back re-arm exhausted; low re-arms only once they are healthy again", async () => {
    // A few credits back (a released hold): exhausted can fire again, low can't.
    autumn.get(acme.id).credits = 300;
    await sync();
    expect(await level()).toBe(1);
    await reserve(300);
    expect(subjects()).toEqual(["Out of credits on acme"]);
    drain();

    // A top-up: back above the line, so both re-arm.
    await autumn.attach({ customerId: acme.id, planId: "top_up", credits: 2_500, successUrl: "" });
    await sync();
    expect(await level()).toBe(0);
    expect(sent).toHaveLength(0);
    await reserve(2_100); // 400
    expect(subjects()).toEqual(["400 credits left on acme"]);
    drain();

    // The plan renews: 6,000 again, and re-armed.
    autumn.get(acme.id).credits = 6_000;
    await sync();
    expect(await level()).toBe(0);
    expect(sent).toHaveLength(0);
  });

  test("a crossing is decided from the stored level, never from a level cached with the balance", async () => {
    const lockbox = { planId: "lockbox", creditsResetAt: null, autoTopUp: null };
    await noticeCredits(acme, { ...lockbox, credits: 0 }, now());
    expect(subjects()).toEqual(["Out of credits on acme"]);
    drain();
    // Two observers read the row at level 2. The healthy one records the recovery first...
    await noticeCredits(acme, { ...lockbox, credits: 6_000 }, now());
    expect(await level()).toBe(0);
    // ...then the newer low one arrives still carrying level 2 from its earlier read. It is a real crossing.
    const carriesStaleLevel = { ...lockbox, credits: 300, creditLevel: 2 };
    await noticeCredits(acme, carriesStaleLevel, now());
    expect(subjects()).toEqual(["300 credits left on acme"]);
    drain();
    await noticeCredits(acme, { ...lockbox, credits: 6_000 }, now());
  });

  test("an answer asked for before a newer one counted changes nothing, in either direction", async () => {
    const lockbox = { planId: "lockbox", creditsResetAt: null, autoTopUp: null };
    const earlier = { from: new Date(Date.now() - 2_000), to: new Date(Date.now() - 1_000) };
    // A healthy read leaves the level at ok, but still counts as the newest.
    await noticeCredits(acme, { ...lockbox, credits: 6_000 }, now());
    // A read of 0 that left before it and arrived late: no false "out of credits".
    await noticeCredits(acme, { ...lockbox, credits: 0 }, earlier);
    expect(sent).toHaveLength(0);
    expect(await level()).toBe(0);

    // The other way: a crossing is announced, then a late healthy answer must not re-arm it.
    await noticeCredits(acme, { ...lockbox, credits: 300 }, now());
    expect(subjects()).toEqual(["300 credits left on acme"]);
    drain();
    await noticeCredits(acme, { ...lockbox, credits: 4_000 }, earlier);
    expect(await level()).toBe(1);
    await noticeCredits(acme, { ...lockbox, credits: 200 }, now());
    expect(sent).toHaveLength(0);
    // A newer healthy answer does re-arm.
    await noticeCredits(acme, { ...lockbox, credits: 4_000 }, now());
    expect(await level()).toBe(0);
  });

  test("concurrent observers announce a crossing once", async () => {
    const snapshot = { planId: "lockbox", credits: 300, creditsResetAt: null, autoTopUp: null };
    const seen = now();
    await Promise.all(Array.from({ length: 12 }, () => noticeCredits(acme, snapshot, seen)));
    expect(subjects()).toEqual(["300 credits left on acme"]);
    drain();
    await noticeCredits(acme, { ...snapshot, credits: 6_000 }, now());

    // Concurrent scans reserving across the line: at most one email, even when answers overlap.
    autumn.get(acme.id).credits = 5_400;
    await sync();
    autumn.latencyMs = 20;
    try {
      await Promise.all(Array.from({ length: 10 }, () => reserve(500)));
    } finally {
      autumn.latencyMs = 0;
    }
    expect(autumn.get(acme.id).credits).toBe(400);
    expect(sent.length).toBeLessThanOrEqual(1);
    // Whatever overlapped, the scan's charge reads Autumn afterwards, and that announces it if nothing did.
    await sync();
    expect(subjects()).toEqual(["400 credits left on acme"]);
    drain();
    autumn.get(acme.id).credits = 6_000;
    await sync();
  });

  test("with auto top-up on, a low or empty balance is left to it, whatever reads it", async () => {
    // Exhausted first, with auto top-up off.
    await noticeCredits(acme, { planId: "lockbox", credits: 0, creditsResetAt: null, autoTopUp: null }, now());
    expect(subjects()).toEqual(["Out of credits on acme"]);
    drain();
    await noticeCredits(acme, { planId: "lockbox", credits: 6_000, creditsResetAt: null, autoTopUp: null }, now());

    await applyAutoTopUp(acme.id, "lockbox", { enabled: true, monthlyLimitUsd: 40 });
    await sync();
    const on = { planId: "lockbox", creditsResetAt: null, autoTopUp: { enabled: true, threshold: 1_500, quantity: 2_500, perMonth: 4 } };
    // A reservation, a refusal's read, a page refresh: all in the seconds before the top-up lands.
    await noticeCredits(acme, { ...on, credits: 1_000 }, now());
    await noticeCredits(acme, { ...on, credits: 0 }, now());
    autumn.get(acme.id).credits = 0;
    await sync();
    expect(sent).toHaveLength(0);
    expect(await level()).toBe(0);

    // The level can still fall, re-arming the emails for when auto top-up is turned off.
    await database.$client`update org_billing set credit_level = 2 where org_id = ${acme.id}`;
    await noticeCredits(acme, { ...on, credits: 300 }, now());
    expect(await level()).toBe(1);
    expect(sent).toHaveLength(0);

    await applyAutoTopUp(acme.id, "lockbox", { enabled: false, monthlyLimitUsd: 40 });
    autumn.get(acme.id).credits = 6_000;
    await sync();
    expect(await level()).toBe(0);
  });

  test("the email toggle doesn't silence billing emails; without a mailer a crossing waits for one", async () => {
    await setSettings({ checkThreshold: "high", emailNotifications: false });
    await noticeCredits(acme, { planId: "lockbox", credits: 300, creditsResetAt: null, autoTopUp: null }, now());
    expect(subjects()).toEqual(["300 credits left on acme"]);
    drain();

    setMailer({ enabled: false, send: async () => void sent.push({ to: [], subject: "should not send", html: "", text: "" }) });
    try {
      await noticeCredits(acme, { planId: "lockbox", credits: 0, creditsResetAt: null, autoTopUp: null }, now());
      expect(await level()).toBe(1);
      expect(sent).toHaveLength(0);
    } finally {
      setMailer(recordingMailer);
    }
    await noticeCredits(acme, { planId: "lockbox", credits: 0, creditsResetAt: null, autoTopUp: null }, now());
    expect(subjects()).toEqual(["Out of credits on acme"]);
    drain();
    await noticeCredits(acme, { planId: "lockbox", credits: 6_000, creditsResetAt: null, autoTopUp: null }, now());
    expect(await level()).toBe(0);
  });

  test("with no admin to tell, nothing is reserved, so the email goes out once there is one", async () => {
    const { org } = await upsertInstallation(database, 603, { githubAccountId: 6300, githubLogin: "lonely", type: "Organization" }, []);
    const lonely = { id: org.id, githubLogin: "lonely" };
    await saveOrgBilling(database, org.id, { planId: "lockbox", pastDue: false, endsAt: null, renewsAt: null, nextPlanId: null, credits: 300, creditsResetAt: null, autoTopUp: null });
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(" "));
    try {
      await noticeCredits(lonely, { planId: "lockbox", credits: 300, creditsResetAt: null, autoTopUp: null }, now());
      expect(await noticeAutoTopUp(lonely, { invoiceId: "in_lonely", added: 2_500, charged: "$10.00", credits: 3_400 })).toBe("skipped");
    } finally {
      console.warn = original;
    }
    expect(sent).toHaveLength(0);
    expect((await orgBillingRow(database, org.id))!.creditLevel).toBe(0);
    expect(warned).toEqual([`No admin of org ${org.id} to email: low credits email not sent`, `No admin of org ${org.id} to email: auto top-up email not sent`]);

    const [admin] = await database.insert(schema.users).values({ name: "erin", email: "erin@example.com", login: "erin" }).returning();
    await database.insert(schema.orgAdmins).values({ userId: admin!.id, orgId: org.id });
    await noticeCredits(lonely, { planId: "lockbox", credits: 200, creditsResetAt: null, autoTopUp: null }, now());
    expect(await noticeAutoTopUp(lonely, { invoiceId: "in_lonely", added: 2_500, charged: "$10.00", credits: 3_400 })).toBe("sent");
    expect(sent.map((email) => [email.to, email.subject])).toEqual([
      [["erin@example.com"], "200 credits left on lonely"],
      [["erin@example.com"], "Auto top-up: 2,500 credits added to lonely"],
    ]);
    drain();
  });

  test("an org without a plan gets no credit emails", async () => {
    await noticeCredits(acme, { planId: null, credits: 0, creditsResetAt: null, autoTopUp: null }, now());
    expect(sent).toHaveLength(0);
    expect(await level()).toBe(0);
  });
});

describe.skipIf(!available)("Autumn webhooks", () => {
  test("the route is off without a signing secret", async () => {
    delete process.env.AUTUMN_WEBHOOK_SECRET;
    resetConfig();
    try {
      expect((await autumnWebhook(delivery(toppedUp("in_off", 4_000)))).status).toBe(404);
    } finally {
      process.env.AUTUMN_WEBHOOK_SECRET = WEBHOOK_SECRET;
      resetConfig();
    }
  });

  test("unsigned, mis-signed, altered and stale deliveries are refused", async () => {
    const payload = toppedUp("in_forged", 4_000);
    const unsigned = new Request("https://sandchest.test/api/autumn/webhooks", { method: "POST", body: JSON.stringify(payload) });
    expect((await autumnWebhook(unsigned)).status).toBe(401);
    expect((await autumnWebhook(delivery(payload, { secret: `whsec_${Buffer.from("not-the-secret").toString("base64")}` }))).status).toBe(401);
    const signed = delivery(payload);
    const altered = new Request(signed.url, { method: "POST", headers: signed.headers, body: JSON.stringify({ ...payload, data: { ...payload.data, quantity_granted: 250_000 } }) });
    expect((await autumnWebhook(altered)).status).toBe(401);
    // A captured delivery replayed six minutes later.
    expect((await autumnWebhook(delivery(payload, { at: Date.now() - 6 * 60_000 }))).status).toBe(401);
    expect((await autumnWebhook(delivery(null, { body: "{not json" }))).status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  test("auto top-up succeeded: one email per invoice, and only a first delivery re-reads the balance", async () => {
    const lockbox = { planId: "lockbox", creditsResetAt: null, autoTopUp: null };
    await noticeCredits(acme, { ...lockbox, credits: 300 }, now());
    drain();
    // The top-up landed in Autumn.
    autumn.get(acme.id).credits = 3_400;
    const reads = autumn.calls.filter((call) => call === "customer").length;
    tick();
    const response = await autumnWebhook(delivery(toppedUp("in_1", 3_400)));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ handled: "billing.auto_topup_succeeded" });
    expect(subjects()).toEqual(["Auto top-up: 2,500 credits added to acme"]);
    expect([...sent[0]!.to].sort()).toEqual(ADMINS);
    expect(sent[0]!.text).toContain("bought 2,500 credits for $10.00");
    expect(sent[0]!.html).toContain(">3,400<");
    // Read from Autumn again: low re-armed from the balance as it is now.
    expect(autumn.calls.filter((call) => call === "customer").length).toBe(reads + 1);
    expect(await orgBillingRow(database, acme.id)).toMatchObject({ creditLevel: 0, credits: 3_400 });
    drain();

    // Credits run low again; then Svix redelivers the old invoice, carrying its old balance. Nothing changes.
    autumn.get(acme.id).credits = 200;
    await sync();
    expect(subjects()).toEqual(["200 credits left on acme"]);
    drain();
    const before = autumn.calls.length;
    expect(await (await autumnWebhook(delivery(toppedUp("in_1", 3_400)))).json()).toEqual({ handled: "billing.auto_topup_succeeded (already sent)" });
    expect(autumn.calls.length).toBe(before);
    expect(await level()).toBe(1);

    // A new invoice's payload balance is not trusted either: Autumn says 800, so it is still low.
    tick();
    await Promise.all(Array.from({ length: 5 }, () => autumnWebhook(delivery(toppedUp("in_2", 5_900)))));
    expect(subjects()).toEqual(["Auto top-up: 2,500 credits added to acme"]);
    expect(await level()).toBe(1);
    drain();
    autumn.get(acme.id).credits = 6_000;
    await sync();
  });

  test("auto top-up failed: card and limit failures email once a day each; Autumn's own errors don't", async () => {
    await autumnWebhook(delivery(topUpFailed("charge_failed")));
    await autumnWebhook(delivery(topUpFailed("missing_payment_method")));
    await autumnWebhook(delivery(topUpFailed("purchase_limit_reached", null)));
    await autumnWebhook(delivery(topUpFailed("attempt_limit_reached")));
    const ignored = await autumnWebhook(delivery(topUpFailed("lock_contention")));
    expect(await ignored.json()).toEqual({ ignored: "auto top-up failed: lock_contention" });
    expect(subjects()).toEqual(["Auto top-up failed for acme", "Auto top-up hit its monthly limit on acme"]);
    expect(sent[0]!.text).toContain("acme is down to 800 credits, and auto top-up couldn’t charge the card on file.");
    expect(sent[1]!.text).toContain("acme is low on credits");
    // Nothing from Stripe's error reaches the email.
    expect(sent[0]!.text).not.toContain("declined");
    drain();
  });

  test("a plan change re-reads the org, so a first plan starts recon without anyone returning to the dashboard", async () => {
    const { org } = await upsertInstallation(database, 602, { githubAccountId: 6200, githubLogin: "solo", type: "User" }, [{ githubRepoId: 62, fullName: "solo/app", private: false, defaultBranch: "main" }]);
    await autumn.attach({ customerId: org.id, planId: "chest", successUrl: "" });
    const before = started.length;
    const response = await autumnWebhook(delivery({ type: "billing.updated", data: { object: "billing.updated", customer_id: org.id, plan_changes: [{ action: "activated", subscription: { plan_id: "chest", status: "active" } }], tags: [] } }));
    expect(await response.json()).toEqual({ handled: "billing.updated" });
    expect((await orgBillingRow(database, org.id))?.planId).toBe("chest");
    expect(started.length - before).toBe(1);
    // A redelivery queues nothing more.
    await autumnWebhook(delivery({ type: "billing.updated", data: { customer_id: org.id } }));
    expect(started.length - before).toBe(1);
  });

  test("a mail outage is logged without addresses and doesn't make Autumn retry; plan changes are ignored with billing off", async () => {
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
    setMailer({ enabled: true, send: async () => Promise.reject(new Error("550 rejected <alice@example.com>")) });
    try {
      expect((await autumnWebhook(delivery(toppedUp("in_outage", 4_000)))).status).toBe(200);
    } finally {
      setMailer(recordingMailer);
      console.error = original;
    }
    expect(logged).toEqual([`Email to the admins of org ${acme.id} failed: Error`]);
    // Reserved all the same: at most once.
    expect(await (await autumnWebhook(delivery(toppedUp("in_outage", 4_000)))).json()).toEqual({ handled: "billing.auto_topup_succeeded (already sent)" });

    setAutumn(undefined);
    try {
      expect(await (await autumnWebhook(delivery({ type: "billing.updated", data: { customer_id: acme.id } }))).json()).toEqual({ ignored: "billing is off" });
    } finally {
      setAutumn(autumn);
    }
    expect(sent).toHaveLength(0);
  });

  test("unknown customers, other features and other events are acknowledged without effect", async () => {
    const answers = await Promise.all(
      [
        toppedUp("in_stranger", 4_000, "00000000-0000-4000-8000-000000000999"),
        toppedUp("in_not_uuid", 4_000, "user_123"),
        { ...toppedUp("in_tokens", 4_000), data: { ...toppedUp("in_tokens", 4_000).data, feature_id: "tokens" } },
        { type: "balances.limit_reached", data: { customer_id: acme.id, feature_id: "credits", limit_type: "included" } },
        { type: "invoice.finalized", data: {} },
        [],
      ].map(async (payload) => {
        const response = await autumnWebhook(delivery(payload));
        return [response.status, await response.json()];
      }),
    );
    expect(answers).toEqual([
      [200, { ignored: "unknown customer" }],
      [200, { ignored: "unknown customer" }],
      [200, { ignored: "not credits" }],
      [200, { ignored: "balances.limit_reached" }],
      [200, { ignored: "invoice.finalized" }],
      [200, { ignored: "malformed" }],
    ]);
    expect(sent).toHaveLength(0);
  });

  test("charges are shown in the invoice's currency", () => {
    expect(money(1000, "usd")).toBe("$10.00");
    expect(money(850, "GBP")).toBe("£8.50");
    expect(money(1500, "jpy")).toBe("¥1,500");
  });
});

describe.skipIf(!available)("scan paused", () => {
  const scan = async (kind: PausedScan["kind"]): Promise<PausedScan> => {
    const [row] = await database.insert(schema.scans).values({ repoId, orgId: acme.id, kind, trigger: "manual", headSha: crypto.randomUUID(), status: "failed", prNumber: kind === "pr_review" ? 7 : null }).returning();
    const org = await database.query.orgs.findFirst({ where: (orgs, { eq }) => eq(orgs.id, acme.id) });
    return { id: row!.id, kind, prNumber: row!.prNumber, repo: { fullName: "acme/api", org: org! } };
  };

  test("once per scan, at most once an hour per org, never for fix checks, and off with the toggle", async () => {
    await setSettings({ checkThreshold: "high" });
    const nine = new Date("2030-01-01T09:05:00Z");
    const first = await scan("pr_review");
    expect(await noticeScanPaused(first, nine)).toBe(true);
    expect(subjects()).toEqual(["Scan paused: acme/api"]);
    expect([...sent[0]!.to].sort()).toEqual(ADMINS);
    expect(sent[0]!.text).toContain("The review of pull request #7 in acme/api stopped");
    expect(sent[0]!.html).toContain(`https://sandchest.test/dashboard/scans/${first.id}`);
    drain();

    // The same scan again (a retried step), and another scan in the same hour.
    expect(await noticeScanPaused(first, nine)).toBe(false);
    expect(await noticeScanPaused(await scan("deep"), new Date("2030-01-01T09:55:00Z"))).toBe(false);
    expect(await noticeScanPaused(await scan("fix_check"), new Date("2030-01-01T11:00:00Z"))).toBe(false);
    expect(sent).toHaveLength(0);

    // The next hour, concurrently: one email.
    const ten = new Date("2030-01-01T10:01:00Z");
    const results = await Promise.all([await scan("deep"), await scan("deep"), await scan("recon")].map((s) => noticeScanPaused(s, ten)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(sent).toHaveLength(1);
    drain();

    const quiet = await scan("deep");
    quiet.repo.org.settings = { checkThreshold: "high", emailNotifications: false };
    expect(await noticeScanPaused(quiet, new Date("2030-01-01T12:00:00Z"))).toBe(false);
    expect(sent).toHaveLength(0);
  });
});

describe.skipIf(!available)("admins nobody has confirmed lately", () => {
  let nextGithubId = 9_000;
  /** An org whose admins all last signed in 40 days ago. */
  async function staleOrg(installationId: number, login: string, type: "User" | "Organization", admins: Array<{ login: string; githubUserId?: number }>) {
    const accountId = installationId * 100; // Clear of the other accounts in this file.
    const { org, repos } = await upsertInstallation(database, installationId, { githubAccountId: accountId, githubLogin: login, type }, [
      { githubRepoId: installationId, fullName: `${login}/private-app`, private: true, defaultBranch: "main" },
    ]);
    const old = new Date(Date.now() - 40 * 86_400_000);
    const ids: Record<string, number> = {};
    for (const admin of admins) {
      const githubUserId = admin.githubUserId ?? ++nextGithubId;
      ids[admin.login] = githubUserId;
      const [user] = await database.insert(schema.users).values({ name: admin.login, email: `${admin.login}@example.com`, login: admin.login, githubUserId }).returning();
      await database.insert(schema.orgAdmins).values({ userId: user!.id, orgId: org.id, checkedAt: old });
    }
    return { org: { id: org.id, githubLogin: login, settings: org.settings }, repoId: repos[0]!.id, accountId, ids };
  }
  /** org_admins as stored: dashboard access, which emails must never change. */
  const adminRows = async (orgId: string) =>
    (await database.query.orgAdmins.findMany({ where: (rows, { eq }) => eq(rows.orgId, orgId) })).map((row) => `${row.userId}@${row.checkedAt.toISOString()}`).sort();
  const withWarnings = async <T>(task: () => Promise<T>): Promise<{ result: T; warned: string[] }> => {
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(" "));
    try {
      return { result: await task(), warned };
    } finally {
      console.warn = original;
    }
  };

  test("a stale admin doesn't get 'scan paused', which names private repositories", async () => {
    const { org, repoId: staleRepo } = await staleOrg(604, "oldco", "Organization", [{ login: "frank" }]);
    const [row] = await database.insert(schema.scans).values({ repoId: staleRepo, orgId: org.id, kind: "pr_review", trigger: "webhook", headSha: "abc", status: "failed", prNumber: 3 }).returning();
    githubAsked.length = 0;
    const { result, warned } = await withWarnings(() => noticeScanPaused({ id: row!.id, kind: "pr_review", prNumber: 3, repo: { fullName: "oldco/private-app", org } }));
    expect(result).toBe(false);
    expect(sent).toHaveLength(0);
    expect(githubAsked).toEqual([]);
    expect(warned).toEqual([`No admin of org ${org.id} to email: scan paused email not sent`]);
    // Nothing was reserved, so the scan can still be announced once someone is confirmed.
    expect((await database.query.scans.findFirst({ where: (scans, { eq }) => eq(scans.id, row!.id) }))!.notifiedAt).toBeNull();
  });

  test("with only stale admins, billing emails ask GitHub and go only to the same accounts still admins, changing nothing stored", async () => {
    const { org, ids } = await staleOrg(605, "driftco", "Organization", [{ login: "grace" }, { login: "heidi" }, { login: "kim" }]);
    githubMembers.set("driftco/grace", { userId: ids.grace!, role: "admin" });
    githubMembers.set("driftco/heidi", { userId: ids.heidi!, role: "member" });
    // Kim renamed; someone else took the username and is an admin. That is not Kim.
    githubMembers.set("driftco/kim", { userId: 202_202, role: "admin" });
    const before = await adminRows(org.id);
    githubAsked.length = 0;
    expect(await noticeAutoTopUp(org, { invoiceId: "in_drift_1", added: 2_500, charged: "$10.00", credits: 3_400 })).toBe("sent");
    expect(sent.map((email) => email.to)).toEqual([["grace@example.com"]]);
    expect(githubAsked.sort()).toEqual(["605:driftco/grace", "605:driftco/heidi", "605:driftco/kim"]);
    // Dashboard access is signing in's business only: no row removed or refreshed.
    expect(await adminRows(org.id)).toEqual(before);
    drain();
    // Within a minute, the next email reuses GitHub's answer...
    expect(await noticeAutoTopUp(org, { invoiceId: "in_drift_2", added: 2_500, charged: "$10.00", credits: 5_900 })).toBe("sent");
    expect(githubAsked).toHaveLength(3);
    expect(sent.map((email) => email.to)).toEqual([["grace@example.com"]]);
    drain();
    // ...and after it, asks again.
    forgetAdminChecks();
    expect(await noticeAutoTopUp(org, { invoiceId: "in_drift_3", added: 2_500, charged: "$10.00", credits: 5_900 })).toBe("sent");
    expect(githubAsked).toHaveLength(6);
    drain();
  });

  test("a personal account's admin is its owner; no need to ask GitHub", async () => {
    const { org, accountId } = await staleOrg(606, "pat", "User", [{ login: "pat", githubUserId: 60_600 }, { login: "mallory", githubUserId: 60_601 }]);
    expect(accountId).toBe(60_600);
    const before = await adminRows(org.id);
    githubAsked.length = 0;
    expect(await noticeAutoTopUp(org, { invoiceId: "in_pat", added: 2_500, charged: "$10.00", credits: 3_400 })).toBe("sent");
    expect(sent.map((email) => email.to)).toEqual([["pat@example.com"]]);
    expect(githubAsked).toEqual([]);
    expect(await adminRows(org.id)).toEqual(before);
    drain();
  });

  test("if GitHub can't be asked, billing emails go to the stale admins, and nothing is recorded", async () => {
    const { org } = await staleOrg(607, "downco", "Organization", [{ login: "ivan" }, { login: "judy" }]);
    const before = await adminRows(org.id);
    githubDown = true;
    try {
      const { result, warned } = await withWarnings(() => noticeAutoTopUpFailed(org, { reason: "card", credits: 300 }));
      expect(result).toBe("sent");
      expect(warned).toEqual([`Couldn't check the admins of org ${org.id} with GitHub (Error): emailing the last known ones`]);
    } finally {
      githubDown = false;
    }
    expect(sent.map((email) => [...email.to].sort())).toEqual([["ivan@example.com", "judy@example.com"]]);
    expect(await adminRows(org.id)).toEqual(before);
    drain();
    // A failure isn't remembered: once GitHub answers, its answer counts (Judy is still an admin, Ivan isn't).
    const ids = Object.fromEntries((await orgAdminContacts(database, org.id)).map((admin) => [admin.login, admin.githubUserId]));
    githubMembers.set("downco/judy", { userId: ids.judy!, role: "admin" });
    githubAsked.length = 0;
    expect(await noticeAutoTopUpFailed(org, { reason: "limit", credits: 300 })).toBe("sent");
    expect(githubAsked).toHaveLength(2);
    expect(sent.map((email) => email.to)).toEqual([["judy@example.com"]]);
    drain();
  });

  test("a balance that went stale while its recipients were found changes nothing", async () => {
    const { org, ids } = await staleOrg(608, "raceco", "Organization", [{ login: "lena" }]);
    githubMembers.set("raceco/lena", { userId: ids.lena!, role: "admin" });
    await saveOrgBilling(database, org.id, { planId: "lockbox", pastDue: false, endsAt: null, renewsAt: null, nextPlanId: null, credits: 6_000, creditsResetAt: null, autoTopUp: null });
    const lockbox = { planId: "lockbox", creditsResetAt: null, autoTopUp: null };
    const earlier = { from: new Date(Date.now() - 2_000), to: new Date(Date.now() - 1_000) };
    // While GitHub is asked about the low balance, a newer healthy balance counts. No lock is held across
    // the call (it would deadlock here), and the older balance is then stale: nothing recorded or sent.
    whileAsking = async () => {
      whileAsking = undefined;
      await noticeCredits(org, { ...lockbox, credits: 6_000 }, now());
    };
    await noticeCredits(org, { ...lockbox, credits: 300 }, earlier);
    expect(sent).toHaveLength(0);
    expect((await orgBillingRow(database, org.id))!.creditLevel).toBe(0);
    // A later low balance announces it.
    await noticeCredits(org, { ...lockbox, credits: 200 }, now());
    expect(sent.map((email) => [email.to, email.subject])).toEqual([[["lena@example.com"], "200 credits left on raceco"]]);
    drain();
  });

  /** Holds every GitHub call until released, so a test decides who commits first. */
  function holdGithub() {
    const held: Array<() => void> = [];
    whileAsking = () => new Promise<void>((resolve) => void held.push(resolve));
    const until = async (count: number) => {
      for (let i = 0; i < 1_000 && held.length < count; i++) await Bun.sleep(2);
      expect(held.length).toBe(count);
    };
    return { held, until, stop: () => (whileAsking = undefined) };
  }

  async function orgWithBilling(installationId: number, login: string, admin: string) {
    const made = await staleOrg(installationId, login, "Organization", [{ login: admin }]);
    githubMembers.set(`${login}/${admin}`, { userId: made.ids[admin]!, role: "admin" });
    await saveOrgBilling(database, made.org.id, { planId: "lockbox", pastDue: false, endsAt: null, renewsAt: null, nextPlanId: null, credits: 6_000, creditsResetAt: null, autoTopUp: null });
    return made.org;
  }
  const lockbox = { planId: "lockbox", creditsResetAt: null, autoTopUp: null };

  test("an older low and a newer exhausted balance both finding recipients at once: both are announced, in turn", async () => {
    const org = await orgWithBilling(609, "waveco", "nina");
    const t = Date.now();
    const lowSeen = { from: new Date(t - 3_000), to: new Date(t - 2_000) };
    const emptySeen = { from: new Date(t - 1_000), to: new Date(t) };
    const gate = holdGithub();
    // Both find a crossing from level 0, then wait on GitHub for who to tell.
    const low = noticeCredits(org, { ...lockbox, credits: 300 }, lowSeen);
    await gate.until(1);
    const empty = noticeCredits(org, { ...lockbox, credits: 0 }, emptySeen);
    await gate.until(2);
    gate.stop();
    // The older low balance records first; the empty one then takes its turn from level 1.
    gate.held[0]!();
    await low;
    gate.held[1]!();
    await empty;
    expect(subjects()).toEqual(["300 credits left on waveco", "Out of credits on waveco"]);
    expect((await orgBillingRow(database, org.id))!.creditLevel).toBe(2);
    drain();
  });

  test("ties are stale: low, then healthy and a delayed low in the same millisecond, send one low email", async () => {
    const org = await orgWithBilling(610, "abaco", "olga");
    const T = new Date();
    const same = { from: T, to: T };
    await noticeCredits(org, { ...lockbox, credits: 300 }, same);
    expect(subjects()).toEqual(["300 credits left on abaco"]);
    // A healthy balance and a delayed low one, both from the same millisecond: neither counts.
    await noticeCredits(org, { ...lockbox, credits: 6_000 }, same);
    await noticeCredits(org, { ...lockbox, credits: 300 }, same);
    expect(subjects()).toEqual(["300 credits left on abaco"]);
    expect((await orgBillingRow(database, org.id))!.creditLevel).toBe(1);
    // Concurrently, too.
    await Promise.all([6_000, 900, 6_000, 900].map((credits) => noticeCredits(org, { ...lockbox, credits }, same)));
    expect(sent).toHaveLength(1);
    drain();
    // The next balance counts.
    await noticeCredits(org, { ...lockbox, credits: 6_000 }, now());
    expect((await orgBillingRow(database, org.id))!.creditLevel).toBe(0);
  });

  test("a crossing dropped as a tie is announced by the next balance, and never twice", async () => {
    const org = await orgWithBilling(612, "tieco", "quinn");
    const T = new Date();
    await noticeCredits(org, { ...lockbox, credits: 300 }, { from: T, to: T });
    expect(subjects()).toEqual(["300 credits left on tieco"]);
    // Exhausted, asked for in the millisecond the low answer arrived: a tie, so dropped.
    await noticeCredits(org, { ...lockbox, credits: 0 }, { from: T, to: T });
    expect(sent).toHaveLength(1);
    // The next balance announces it, once.
    await noticeCredits(org, { ...lockbox, credits: 0 }, now());
    await noticeCredits(org, { ...lockbox, credits: 0 }, now());
    expect(subjects()).toEqual(["300 credits left on tieco", "Out of credits on tieco"]);
    drain();
  });

  test("five overlapping healthy balances, then a fresher exhausted one: exhausted is announced", async () => {
    const org = await orgWithBilling(613, "fiveco", "rosa");
    const base = Date.now() + 10;
    // Five healthy answers whose windows overlap, arriving in any order.
    await Promise.all(
      [3, 1, 4, 0, 2].map((i) => noticeCredits(org, { ...lockbox, credits: 6_000 }, { from: new Date(base + i), to: new Date(base + 5 + i) })),
    );
    expect(sent).toHaveLength(0);
    await noticeCredits(org, { ...lockbox, credits: 0 }, { from: new Date(base + 20), to: new Date(base + 21) });
    expect(subjects()).toEqual(["Out of credits on fiveco"]);
    drain();
  });

  test("each crossing finds its recipients afresh: an admin who changed in between is not reused", async () => {
    const { org: made, ids } = await staleOrg(614, "swapco", "Organization", [{ login: "sam" }]);
    await saveOrgBilling(database, made.id, { planId: "lockbox", pastDue: false, endsAt: null, renewsAt: null, nextPlanId: null, credits: 6_000, creditsResetAt: null, autoTopUp: null });
    githubMembers.set("swapco/sam", { userId: ids.sam!, role: "admin" });
    await noticeCredits(made, { ...lockbox, credits: 300 }, now());
    expect(sent.map((email) => email.to)).toEqual([["sam@example.com"]]);
    drain();
    // Sam is demoted on GitHub, and Tess becomes an admin who signs in.
    githubMembers.set("swapco/sam", { userId: ids.sam!, role: "member" });
    const [tess] = await database.insert(schema.users).values({ name: "tess", email: "tess@example.com", login: "tess", githubUserId: 61_400 }).returning();
    await database.insert(schema.orgAdmins).values({ userId: tess!.id, orgId: made.id });
    await noticeCredits(made, { ...lockbox, credits: 0 }, now());
    expect(sent.map((email) => email.to)).toEqual([["tess@example.com"]]);
    drain();
  });

  test("waves of 100 concurrent observers: one email per crossing, none for recoveries", async () => {
    const org = await orgWithBilling(611, "crowdco", "pia");
    githubAsked.length = 0;
    for (const credits of [300, 6_000, 0, 6_000, 400, 0]) {
      await Promise.all(Array.from({ length: 100 }, () => noticeCredits(org, { ...lockbox, credits }, now())));
    }
    expect(subjects()).toEqual(["300 credits left on crowdco", "Out of credits on crowdco", "400 credits left on crowdco", "Out of credits on crowdco"]);
    drain();
  });
});

describe.skipIf(!available)("a crossing that only exists once the lock is taken", () => {
  test("an exhausted balance that read level 2 before a healthy one committed 0 still finds recipients, and is announced once", async () => {
    const { org } = await upsertInstallation(database, 615, { githubAccountId: 61_500, githubLogin: "lockco", type: "Organization" }, []);
    const lockco = { id: org.id, githubLogin: "lockco" };
    const [owner] = await database.insert(schema.users).values({ name: "uma", email: "uma@example.com", login: "uma", githubUserId: 61_501 }).returning();
    await database.insert(schema.orgAdmins).values({ userId: owner!.id, orgId: org.id });
    await saveOrgBilling(database, org.id, { planId: "lockbox", pastDue: false, endsAt: null, renewsAt: null, nextPlanId: null, credits: 0, creditsResetAt: null, autoTopUp: null });
    const lockbox = { planId: "lockbox", creditsResetAt: null, autoTopUp: null };
    await noticeCredits(lockco, { ...lockbox, credits: 0 }, now());
    expect(subjects()).toEqual(["Out of credits on lockco"]);
    drain();

    // The reviewer's schedule: a healthy balance's update holds the row lock with level 0, not yet committed.
    // Meanwhile a newer exhausted balance starts; anything it reads now still says level 2. It waits for the lock.
    const healthy = now();
    const empty = now();
    const lockWaiters = async () => {
      const [row] = await database.$client`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`;
      return (row as { n: number }).n;
    };
    let exhausted: Promise<void> | undefined;
    await database.$client.begin(async (tx) => {
      await tx`select credit_level from org_billing where org_id = ${org.id} for update`;
      await tx`update org_billing set credit_level = 0, credit_level_at = ${healthy.to.toISOString()}::timestamptz, credit_level_rev = credit_level_rev + 1 where org_id = ${org.id}`;
      exhausted = noticeCredits(lockco, { ...lockbox, credits: 0 }, empty);
      for (let i = 0; i < 1_000 && (await lockWaiters()) === 0; i++) await Bun.sleep(2);
      expect(await lockWaiters()).toBe(1);
    });
    // The healthy update commits; the exhausted balance takes the lock: a real crossing from 0, announced once.
    await exhausted;
    expect(subjects()).toEqual(["Out of credits on lockco"]);
    expect((await orgBillingRow(database, org.id))!.creditLevel).toBe(2);
    drain();
  });
});

describe.skipIf(!available)("logs", () => {
  /** Everything written to the console while `task` runs. */
  async function captured(task: () => Promise<unknown>): Promise<string> {
    const lines: string[] = [];
    const original = { error: console.error, warn: console.warn, log: console.log };
    for (const name of ["error", "warn", "log"] as const) console[name] = (...args: unknown[]) => void lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    try {
      await task();
    } finally {
      Object.assign(console, original);
    }
    return lines.join("\n");
  }

  test("an error quoting an email address never reaches the logs, from the webhook route or a billing read", async () => {
    const leak = new Error("Customer alice@example.com (Alice Example) could not be read");
    const customer = autumn.customer;
    autumn.customer = async () => Promise.reject(leak);
    try {
      let status = 0;
      const routeLog = await captured(async () => {
        status = (await autumnWebhook(delivery({ type: "billing.updated", data: { customer_id: acme.id } }, { id: "msg_leak" }))).status;
      });
      expect(status).toBe(500);
      expect(routeLog).toBe("Autumn webhook msg_leak failed: Error");

      const pageLog = await captured(() => pageBilling(acme, null));
      expect(pageLog).toBe("Billing read failed: Error");
      for (const log of [routeLog, pageLog]) expect(log).not.toMatch(/@|Alice/);
    } finally {
      autumn.customer = customer;
    }
  });

  test("errors are described by class and status only", () => {
    expect(describeError(new AutumnError("Autumn check: Customer bob@example.com not found", 404, "customer_not_found"))).toBe("AutumnError 404");
    expect(describeError(new TypeError("fetch failed for carol@example.com"))).toBe("TypeError");
    expect(describeError("dave@example.com")).toBe("error");
  });

  test("GitHub's remembered answers expire, and at most 1,000 orgs are remembered, oldest dropped first", () => {
    forgetAdminChecks();
    const t0 = Date.now();
    for (let i = 0; i < 1_005; i++) rememberAdminCheck(`org-${i}`, "admins", [], t0);
    expect(rememberedAdminChecks()).toBe(1_000);
    // A minute later every one of them has expired, and goes on the next access.
    rememberAdminCheck("later", "admins", [], t0 + 61_000);
    expect(rememberedAdminChecks()).toBe(1);
    forgetAdminChecks();
  });
});
