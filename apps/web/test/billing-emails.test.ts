/**
 * Billing and operational emails (SPEC §14) against a real Postgres, with
 * Autumn and the mailer faked: credits low and exhausted (each crossing
 * once, re-armed when credits return), auto top-up results from Autumn's
 * signed webhooks, and a scan paused by the model provider's quota.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { signWebhook } from "@sandchest/billing";
import { createDb, orgAdminContacts, orgBillingRow, saveOrgBilling, schema, upsertInstallation, type Db } from "@sandchest/db";
import { migrate } from "@sandchest/db/migrate";
import type { Email, Mailer } from "@sandchest/email";
import type { GitHubApp } from "@sandchest/github";
import { POST as autumnWebhook } from "@/app/api/autumn/webhooks/route";
import { money } from "@/server/autumn-webhooks";
import { applyAutoTopUp, reserveScan, setAutumn, syncBilling } from "@/server/billing";
import { resetConfig } from "@/server/config";
import { setMailer } from "@/server/mailer";
import { noticeAutoTopUp, noticeAutoTopUpFailed, noticeCredits, noticeScanPaused, type PausedScan } from "@/server/notices";
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

/** GitHub's answer to "is this person still an admin of this org?", asked with an installation's token. */
const githubAdmins = new Set<string>();
const githubAsked: string[] = [];
let githubDown = false;
const fakeGithub = {
  installation: (installationId: number) => ({
    isOrgAdmin: async (org: string, login: string) => {
      githubAsked.push(`${installationId}:${org}/${login}`);
      if (githubDown) throw new Error("GitHub 502: Bad Gateway");
      return githubAdmins.has(`${org}/${login}`);
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

  // Acme buys Lockbox: 60 credits, nothing to say yet.
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
const reserve = (credits: number) => reserveScan(`00000000-0000-4000-8000-${String(++lock).padStart(12, "0")}`, acme, credits, false);
const level = async () => (await orgBillingRow(database, acme.id))!.creditLevel;
const subjects = () => sent.map((email) => email.subject);
/**
 * Who hears about acme's billing: Alice, the admin GitHub confirmed recently. Not Carol, whom it last
 * confirmed 40 days ago (she may have left), Bob (a no-reply placeholder) or Dave (not an admin).
 */
const ADMINS = ["alice@example.com"];
/** A balance seen just now. */
const now = () => {
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
  data: { customer_id: customer, feature_id: "credits", quantity_granted: 25, threshold: 15, balance_after: balanceAfter, invoice_mode: false, invoice: { stripe_id: invoice, status: "paid", total: 1000, currency: "usd", hosted_invoice_url: null } },
});

const topUpFailed = (reason: string, balance: number | null = 8) => ({
  type: "billing.auto_topup_failed",
  id: `evt_auto_topup_failed_${crypto.randomUUID()}`,
  occurred_at: Date.now(),
  data: { customer_id: acme.id, feature_id: "credits", reason, quantity: 25, threshold: 15, balance, invoice_mode: false, error: { code: "card_declined", message: "Your card was declined.", type: "card_error", decline_code: "generic_decline" } },
});

describe.skipIf(!available)("billing emails", () => {
  test("admins GitHub confirmed recently are preferred over stale ones, without asking GitHub", async () => {
    const contacts = await orgAdminContacts(database, acme.id);
    expect(contacts.map((admin) => [admin.email, admin.fresh]).sort()).toEqual([
      ["alice@example.com", true],
      ["carol@example.com", false],
    ]);
    await noticeCredits(acme, { planId: "lockbox", credits: 9, creditsResetAt: null, autoTopUp: null }, now());
    expect(sent.map((email) => email.to)).toEqual([ADMINS]);
    expect(githubAsked).toEqual([]);
    drain();
    await noticeCredits(acme, { planId: "lockbox", credits: 60, creditsResetAt: null, autoTopUp: null }, now());
    expect(await level()).toBe(0);
  });

  test("low: once when credits cross below the plan's line, not again while they stay low", async () => {
    autumn.get(acme.id).credits = 16;
    await reserve(1); // 15: Lockbox's line, still fine
    expect(sent).toHaveLength(0);
    await reserve(1); // 14
    expect(subjects()).toEqual(["14 credits left on acme"]);
    expect([...sent[0]!.to].sort()).toEqual(ADMINS);
    expect(sent[0]!.html).toContain("https://sandchest.test/settings#billing");
    expect(sent[0]!.text).toContain("come back on 1 Jan 2030");
    await reserve(1);
    await syncBilling(acme);
    expect(sent).toHaveLength(1);
    expect(await level()).toBe(1);
    drain();
  });

  test("exhausted: once when nothing is left, not again on refusals or reads", async () => {
    autumn.get(acme.id).credits = 2;
    await reserve(2);
    expect(subjects()).toEqual(["Out of credits on acme"]);
    expect(sent[0]!.text).toContain("Top up to keep digging");
    expect(await reserve(1)).toMatchObject({ ok: false, reason: "out_of_credits" });
    await syncBilling(acme);
    expect(sent).toHaveLength(1);
    expect(await level()).toBe(2);
    drain();
  });

  test("credits coming back re-arm exhausted; low re-arms only once they are healthy again", async () => {
    // A few credits back (a released hold): exhausted can fire again, low can't.
    autumn.get(acme.id).credits = 5;
    await syncBilling(acme);
    expect(await level()).toBe(1);
    await reserve(5);
    expect(subjects()).toEqual(["Out of credits on acme"]);
    drain();

    // A top-up: back above the line, so both re-arm.
    await autumn.attach({ customerId: acme.id, planId: "top_up", packs: 1, successUrl: "" });
    await syncBilling(acme);
    expect(await level()).toBe(0);
    expect(sent).toHaveLength(0);
    await reserve(11); // 14
    expect(subjects()).toEqual(["14 credits left on acme"]);
    drain();

    // The plan renews: 60 again, and re-armed.
    autumn.get(acme.id).credits = 60;
    await syncBilling(acme);
    expect(await level()).toBe(0);
    expect(sent).toHaveLength(0);
  });

  test("an answer asked for before a newer one counted changes nothing, in either direction", async () => {
    const lockbox = { planId: "lockbox", creditsResetAt: null, autoTopUp: null };
    const earlier = { from: new Date(Date.now() - 2_000), to: new Date(Date.now() - 1_000) };
    // A healthy read leaves the level at ok, but still counts as the newest.
    await noticeCredits(acme, { ...lockbox, credits: 60 }, now());
    // A read of 0 that left before it and arrived late: no false "out of credits".
    await noticeCredits(acme, { ...lockbox, credits: 0 }, earlier);
    expect(sent).toHaveLength(0);
    expect(await level()).toBe(0);

    // The other way: a crossing is announced, then a late healthy answer must not re-arm it.
    await noticeCredits(acme, { ...lockbox, credits: 9 }, now());
    expect(subjects()).toEqual(["9 credits left on acme"]);
    drain();
    await noticeCredits(acme, { ...lockbox, credits: 40 }, earlier);
    expect(await level()).toBe(1);
    await noticeCredits(acme, { ...lockbox, credits: 8 }, now());
    expect(sent).toHaveLength(0);
    // A newer healthy answer does re-arm.
    await noticeCredits(acme, { ...lockbox, credits: 40 }, now());
    expect(await level()).toBe(0);
  });

  test("concurrent observers announce a crossing once", async () => {
    const snapshot = { planId: "lockbox", credits: 9, creditsResetAt: null, autoTopUp: null };
    const seen = now();
    await Promise.all(Array.from({ length: 12 }, () => noticeCredits(acme, snapshot, seen)));
    expect(subjects()).toEqual(["9 credits left on acme"]);
    drain();
    await noticeCredits(acme, { ...snapshot, credits: 60 }, now());

    // Concurrent scans reserving across the line: at most one email, even when answers overlap.
    autumn.get(acme.id).credits = 60;
    await syncBilling(acme);
    autumn.latencyMs = 20;
    try {
      await Promise.all(Array.from({ length: 10 }, () => reserve(5)));
    } finally {
      autumn.latencyMs = 0;
    }
    expect(autumn.get(acme.id).credits).toBe(10);
    expect(sent.length).toBeLessThanOrEqual(1);
    // Whatever overlapped, the scan's charge reads Autumn afterwards, and that announces it if nothing did.
    await syncBilling(acme);
    expect(subjects()).toEqual(["10 credits left on acme"]);
    drain();
    autumn.get(acme.id).credits = 60;
    await syncBilling(acme);
  });

  test("with auto top-up on, a low or empty balance is left to it, whatever reads it", async () => {
    // Exhausted first, with auto top-up off.
    await noticeCredits(acme, { planId: "lockbox", credits: 0, creditsResetAt: null, autoTopUp: null }, now());
    expect(subjects()).toEqual(["Out of credits on acme"]);
    drain();
    await noticeCredits(acme, { planId: "lockbox", credits: 60, creditsResetAt: null, autoTopUp: null }, now());

    await applyAutoTopUp(acme.id, "lockbox", { enabled: true, monthlyLimitUsd: 40 });
    await syncBilling(acme);
    const on = { planId: "lockbox", creditsResetAt: null, autoTopUp: { enabled: true, threshold: 15, quantity: 25, perMonth: 4 } };
    // A reservation, a refusal's read, a page refresh: all in the seconds before the top-up lands.
    await noticeCredits(acme, { ...on, credits: 10 }, now());
    await noticeCredits(acme, { ...on, credits: 0 }, now());
    autumn.get(acme.id).credits = 0;
    await syncBilling(acme);
    expect(sent).toHaveLength(0);
    expect(await level()).toBe(0);

    // The level can still fall, re-arming the emails for when auto top-up is turned off.
    await database.$client`update org_billing set credit_level = 2 where org_id = ${acme.id}`;
    await noticeCredits(acme, { ...on, credits: 5 }, now());
    expect(await level()).toBe(1);
    expect(sent).toHaveLength(0);

    await applyAutoTopUp(acme.id, "lockbox", { enabled: false, monthlyLimitUsd: 40 });
    autumn.get(acme.id).credits = 60;
    await syncBilling(acme);
    expect(await level()).toBe(0);
  });

  test("the email toggle doesn't silence billing emails, and without a mailer the level still moves", async () => {
    await setSettings({ checkThreshold: "high", emailNotifications: false });
    await noticeCredits(acme, { planId: "lockbox", credits: 3, creditsResetAt: null, autoTopUp: null }, now());
    expect(subjects()).toEqual(["3 credits left on acme"]);
    drain();

    setMailer({ enabled: false, send: async () => void sent.push({ to: [], subject: "should not send", html: "", text: "" }) });
    try {
      await noticeCredits(acme, { planId: "lockbox", credits: 0, creditsResetAt: null, autoTopUp: null }, now());
      expect(await level()).toBe(2);
      expect(sent).toHaveLength(0);
    } finally {
      setMailer(recordingMailer);
    }
    await noticeCredits(acme, { planId: "lockbox", credits: 60, creditsResetAt: null, autoTopUp: null }, now());
    expect(await level()).toBe(0);
  });

  test("with no admin to tell, nothing is reserved, so the email goes out once there is one", async () => {
    const { org } = await upsertInstallation(database, 603, { githubAccountId: 6300, githubLogin: "lonely", type: "Organization" }, []);
    const lonely = { id: org.id, githubLogin: "lonely" };
    await saveOrgBilling(database, org.id, { planId: "lockbox", pastDue: false, endsAt: null, renewsAt: null, nextPlanId: null, credits: 9, creditsResetAt: null, autoTopUp: null });
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(" "));
    try {
      await noticeCredits(lonely, { planId: "lockbox", credits: 9, creditsResetAt: null, autoTopUp: null }, now());
      expect(await noticeAutoTopUp(lonely, { invoiceId: "in_lonely", added: 25, charged: "$10.00", credits: 34 })).toBe("skipped");
    } finally {
      console.warn = original;
    }
    expect(sent).toHaveLength(0);
    expect((await orgBillingRow(database, org.id))!.creditLevel).toBe(0);
    expect(warned).toEqual([`No admin of org ${org.id} to email: low credits email not sent`, `No admin of org ${org.id} to email: auto top-up email not sent`]);

    const [admin] = await database.insert(schema.users).values({ name: "erin", email: "erin@example.com", login: "erin" }).returning();
    await database.insert(schema.orgAdmins).values({ userId: admin!.id, orgId: org.id });
    await noticeCredits(lonely, { planId: "lockbox", credits: 8, creditsResetAt: null, autoTopUp: null }, now());
    expect(await noticeAutoTopUp(lonely, { invoiceId: "in_lonely", added: 25, charged: "$10.00", credits: 34 })).toBe("sent");
    expect(sent.map((email) => [email.to, email.subject])).toEqual([
      [["erin@example.com"], "8 credits left on lonely"],
      [["erin@example.com"], "Auto top-up: 25 credits added to lonely"],
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
      expect((await autumnWebhook(delivery(toppedUp("in_off", 40)))).status).toBe(404);
    } finally {
      process.env.AUTUMN_WEBHOOK_SECRET = WEBHOOK_SECRET;
      resetConfig();
    }
  });

  test("unsigned, mis-signed, altered and stale deliveries are refused", async () => {
    const payload = toppedUp("in_forged", 40);
    const unsigned = new Request("https://sandchest.test/api/autumn/webhooks", { method: "POST", body: JSON.stringify(payload) });
    expect((await autumnWebhook(unsigned)).status).toBe(401);
    expect((await autumnWebhook(delivery(payload, { secret: `whsec_${Buffer.from("not-the-secret").toString("base64")}` }))).status).toBe(401);
    const signed = delivery(payload);
    const altered = new Request(signed.url, { method: "POST", headers: signed.headers, body: JSON.stringify({ ...payload, data: { ...payload.data, quantity_granted: 2500 } }) });
    expect((await autumnWebhook(altered)).status).toBe(401);
    // A captured delivery replayed six minutes later.
    expect((await autumnWebhook(delivery(payload, { at: Date.now() - 6 * 60_000 }))).status).toBe(401);
    expect((await autumnWebhook(delivery(null, { body: "{not json" }))).status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  test("auto top-up succeeded: one email per invoice, and only a first delivery re-reads the balance", async () => {
    const lockbox = { planId: "lockbox", creditsResetAt: null, autoTopUp: null };
    await noticeCredits(acme, { ...lockbox, credits: 9 }, now());
    drain();
    // The top-up landed in Autumn.
    autumn.get(acme.id).credits = 34;
    const reads = autumn.calls.filter((call) => call === "customer").length;
    const response = await autumnWebhook(delivery(toppedUp("in_1", 34)));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ handled: "billing.auto_topup_succeeded" });
    expect(subjects()).toEqual(["Auto top-up: 25 credits added to acme"]);
    expect([...sent[0]!.to].sort()).toEqual(ADMINS);
    expect(sent[0]!.text).toContain("bought 25 credits for $10.00");
    expect(sent[0]!.html).toContain(">34<");
    // Read from Autumn again: low re-armed from the balance as it is now.
    expect(autumn.calls.filter((call) => call === "customer").length).toBe(reads + 1);
    expect(await orgBillingRow(database, acme.id)).toMatchObject({ creditLevel: 0, credits: 34 });
    drain();

    // Credits run low again; then Svix redelivers the old invoice, carrying its old balance. Nothing changes.
    autumn.get(acme.id).credits = 8;
    await syncBilling(acme);
    expect(subjects()).toEqual(["8 credits left on acme"]);
    drain();
    const before = autumn.calls.length;
    expect(await (await autumnWebhook(delivery(toppedUp("in_1", 34)))).json()).toEqual({ handled: "billing.auto_topup_succeeded (already sent)" });
    expect(autumn.calls.length).toBe(before);
    expect(await level()).toBe(1);

    // A new invoice's payload balance is not trusted either: Autumn says 8, so it is still low.
    await Promise.all(Array.from({ length: 5 }, () => autumnWebhook(delivery(toppedUp("in_2", 59)))));
    expect(subjects()).toEqual(["Auto top-up: 25 credits added to acme"]);
    expect(await level()).toBe(1);
    drain();
    autumn.get(acme.id).credits = 60;
    await syncBilling(acme);
  });

  test("auto top-up failed: card and limit failures email once a day each; Autumn's own errors don't", async () => {
    await autumnWebhook(delivery(topUpFailed("charge_failed")));
    await autumnWebhook(delivery(topUpFailed("missing_payment_method")));
    await autumnWebhook(delivery(topUpFailed("purchase_limit_reached", null)));
    await autumnWebhook(delivery(topUpFailed("attempt_limit_reached")));
    const ignored = await autumnWebhook(delivery(topUpFailed("lock_contention")));
    expect(await ignored.json()).toEqual({ ignored: "auto top-up failed: lock_contention" });
    expect(subjects()).toEqual(["Auto top-up failed for acme", "Auto top-up hit its monthly limit on acme"]);
    expect(sent[0]!.text).toContain("acme is down to 8 credits, and auto top-up couldn’t charge the card on file.");
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
      expect((await autumnWebhook(delivery(toppedUp("in_outage", 40)))).status).toBe(200);
    } finally {
      setMailer(recordingMailer);
      console.error = original;
    }
    expect(logged).toEqual([`Email to the admins of org ${acme.id} failed: Error`]);
    // Reserved all the same: at most once.
    expect(await (await autumnWebhook(delivery(toppedUp("in_outage", 40)))).json()).toEqual({ handled: "billing.auto_topup_succeeded (already sent)" });

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
        toppedUp("in_stranger", 40, "00000000-0000-4000-8000-000000000999"),
        toppedUp("in_not_uuid", 40, "user_123"),
        { ...toppedUp("in_tokens", 40), data: { ...toppedUp("in_tokens", 40).data, feature_id: "tokens" } },
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
    expect(sent[0]!.html).toContain(`https://sandchest.test/scans/${first.id}`);
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
  /** An org whose admins all last signed in 40 days ago. */
  async function staleOrg(installationId: number, login: string, type: "User" | "Organization", admins: Array<{ login: string; githubUserId?: number }>) {
    const accountId = installationId * 10;
    const { org, repos } = await upsertInstallation(database, installationId, { githubAccountId: accountId, githubLogin: login, type }, [
      { githubRepoId: installationId, fullName: `${login}/private-app`, private: true, defaultBranch: "main" },
    ]);
    const old = new Date(Date.now() - 40 * 86_400_000);
    for (const admin of admins) {
      const [user] = await database.insert(schema.users).values({ name: admin.login, email: `${admin.login}@example.com`, login: admin.login, githubUserId: admin.githubUserId ?? null }).returning();
      await database.insert(schema.orgAdmins).values({ userId: user!.id, orgId: org.id, checkedAt: old });
    }
    return { org: { id: org.id, githubLogin: login, settings: org.settings }, repoId: repos[0]!.id, accountId };
  }
  const fresh = async (orgId: string) => (await orgAdminContacts(database, orgId)).map((admin) => [admin.email, admin.fresh]).sort();

  test("a stale admin doesn't get 'scan paused', which names private repositories", async () => {
    const { org, repoId: staleRepo } = await staleOrg(604, "oldco", "Organization", [{ login: "frank" }]);
    const [row] = await database.insert(schema.scans).values({ repoId: staleRepo, orgId: org.id, kind: "pr_review", trigger: "webhook", headSha: "abc", status: "failed", prNumber: 3 }).returning();
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(" "));
    try {
      expect(await noticeScanPaused({ id: row!.id, kind: "pr_review", prNumber: 3, repo: { fullName: "oldco/private-app", org } })).toBe(false);
    } finally {
      console.warn = original;
    }
    expect(sent).toHaveLength(0);
    expect(githubAsked).toEqual([]);
    expect(warned).toEqual([`No admin of org ${org.id} to email: scan paused email not sent`]);
    // Nothing was reserved, so the scan can still be announced once someone is confirmed.
    expect((await database.query.scans.findFirst({ where: (scans, { eq }) => eq(scans.id, row!.id) }))!.notifiedAt).toBeNull();
  });

  test("with only stale admins, billing emails ask GitHub first and go only to those still admins", async () => {
    const { org } = await staleOrg(605, "driftco", "Organization", [{ login: "grace" }, { login: "heidi" }]);
    githubAdmins.add("driftco/grace");
    githubAsked.length = 0;
    expect(await noticeAutoTopUp(org, { invoiceId: "in_drift_1", added: 25, charged: "$10.00", credits: 34 })).toBe("sent");
    expect(sent.map((email) => email.to)).toEqual([["grace@example.com"]]);
    expect(githubAsked.sort()).toEqual(["605:driftco/grace", "605:driftco/heidi"]);
    // GitHub's answer is recorded: Grace is fresh again, Heidi is no longer an admin.
    expect(await fresh(org.id)).toEqual([["grace@example.com", true]]);
    drain();
    // So the next email doesn't need to ask.
    expect(await noticeAutoTopUp(org, { invoiceId: "in_drift_2", added: 25, charged: "$10.00", credits: 59 })).toBe("sent");
    expect(githubAsked).toHaveLength(2);
    drain();
  });

  test("a personal account's admin is its owner; no need to ask GitHub", async () => {
    const { org, accountId } = await staleOrg(606, "pat", "User", [{ login: "pat", githubUserId: 6060 }, { login: "mallory", githubUserId: 6061 }]);
    expect(accountId).toBe(6060);
    githubAsked.length = 0;
    expect(await noticeAutoTopUp(org, { invoiceId: "in_pat", added: 25, charged: "$10.00", credits: 34 })).toBe("sent");
    expect(sent.map((email) => email.to)).toEqual([["pat@example.com"]]);
    expect(githubAsked).toEqual([]);
    expect(await fresh(org.id)).toEqual([["pat@example.com", true]]);
    drain();
  });

  test("if GitHub can't be asked, billing emails go to the stale admins, and nothing is recorded", async () => {
    const { org } = await staleOrg(607, "downco", "Organization", [{ login: "ivan" }, { login: "judy" }]);
    githubDown = true;
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(" "));
    try {
      expect(await noticeAutoTopUpFailed(org, { reason: "card", credits: 3 })).toBe("sent");
    } finally {
      console.warn = original;
      githubDown = false;
    }
    expect(sent.map((email) => [...email.to].sort())).toEqual([["ivan@example.com", "judy@example.com"]]);
    expect(warned).toEqual([`Couldn't check the admins of org ${org.id} with GitHub (Error): emailing the last known ones`]);
    expect(await fresh(org.id)).toEqual([
      ["ivan@example.com", false],
      ["judy@example.com", false],
    ]);
    drain();
  });
});
