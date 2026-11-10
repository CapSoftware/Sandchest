/**
 * The database side of the credit unit switch against a throwaway database on the local Postgres
 * (docker compose -f docker/compose.dev.yml up -d). Skips if it is not running.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import {
  advanceCustomerJournal,
  conversionPlan,
  convertCredits,
  createDb,
  customerJournalRow,
  customerJournalSummary,
  failCustomerJournal,
  heldCreditScans,
  recordCustomerJournal,
  revertCredits,
  schema,
  unswitchedOrgs,
  upsertInstallation,
  type Db,
} from "../src";
import { migrate } from "../src/migrate";

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest";
const NAME = `sandchest_credit_unit_test_${process.pid}`;
let admin: postgres.Sql | undefined;
let database: Db;
let available = true;

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
  database = createDb(url.toString(), { max: 5 });
  await migrate(database);
});

afterAll(async () => {
  if (!available) return;
  await database.$client.end();
  await admin!.unsafe(`drop database if exists ${NAME} with (force)`);
  await admin!.end();
});

const it = (name: string, fn: () => Promise<void>) => test(name, async () => (available ? fn() : console.warn(`skipped (no Postgres): ${name}`)));

/** An org on Standard with 32 credits, auto top-up of 10 below 5, a charged scan, a refused one, a claim and a carry. */
async function seed() {
  const { org, repos } = await upsertInstallation(database, 9100, { githubAccountId: 9100, githubLogin: "acme", type: "Organization" }, [{ githubRepoId: 9101, fullName: "acme/api", private: true, defaultBranch: "main" }]);
  const orgId = org.id;
  const repoId = repos[0]!.id;
  await database.$client`update orgs set settings = ${JSON.stringify({ checkThreshold: "high", autoTopUp: { enabled: true, quantity: 10, monthlyLimitUsd: 50 } })}::jsonb where id = ${orgId}`;
  await database.insert(schema.orgBilling).values({ orgId, planId: "standard", credits: 32, autoTopUp: { enabled: true, threshold: 5, quantity: 10, perMonth: 5 } });
  const [charged] = await database.insert(schema.scans).values({ repoId, orgId, kind: "deep", trigger: "manual", headSha: "a", status: "completed", billing: "charged", credits: 5, creditsReserved: 25 }).returning();
  const [refused] = await database.insert(schema.scans).values({ repoId, orgId, kind: "pr_review", trigger: "webhook", headSha: "b", status: "refused" }).returning();
  await database.insert(schema.creditClaims).values({ githubAccountId: 9100, githubUserId: 9200, orgId, userId: crypto.randomUUID(), credits: 20 });
  await database.insert(schema.usageCarry).values({ orgId, carryMicroUsd: 400_000 });
  return { orgId, repoId, charged: charged!.id, refused: refused!.id };
}

it("converts every amount of credits once, and reverts it exactly", async () => {
  const { orgId, repoId, charged, refused } = await seed();
  const before = await conversionPlan(database);
  expect(before).toMatchObject({ marker: "none", heldScans: 0, scansCredits: { rows: 1, sum: 5 }, scansReserved: { rows: 1, sum: 25 }, creditClaims: { rows: 1, sum: 20 }, orgBillingCredits: { rows: 1, sum: 32 } });
  expect(before.carries).toEqual([{ orgId, microUsd: 400_000 }]);

  // A scan holding credits refuses it, changing nothing.
  const [held] = await database.insert(schema.scans).values({ repoId, orgId, kind: "pr_review", trigger: "webhook", headSha: "c", status: "running", billing: "reserved", creditsReserved: 1 }).returning();
  // A free scan running is marked reserved for 0: it holds nothing, and is not counted.
  await database.insert(schema.scans).values({ repoId, orgId, kind: "fix_check", trigger: "webhook", headSha: "d", status: "running", billing: "reserved", creditsReserved: 0 });
  expect(await heldCreditScans(database)).toBe(1);
  expect(await convertCredits(database)).toMatchObject({ done: false, reason: "held_credits" });
  await database.$client`update scans set billing = 'released', credits_reserved = 1, status = 'failed' where id = ${held!.id}`;
  expect(await heldCreditScans(database)).toBe(0);

  expect(await convertCredits(database)).toMatchObject({ done: true });
  const scan = async (id: string) => (await database.query.scans.findFirst({ where: (s, { eq }) => eq(s.id, id) }))!;
  expect(await scan(charged)).toMatchObject({ credits: 500, creditsReserved: 2_500 });
  expect(await scan(refused)).toMatchObject({ credits: 0, creditsReserved: null });
  expect(await scan(held!.id)).toMatchObject({ creditsReserved: 100 });
  const billing = (await database.query.orgBilling.findFirst({ where: (b, { eq }) => eq(b.orgId, orgId) }))!;
  expect(billing).toMatchObject({ credits: 3_200, autoTopUp: { enabled: true, threshold: 500, quantity: 1_000, perMonth: 5 } });
  const org = (await database.query.orgs.findFirst({ where: (o, { eq }) => eq(o.id, orgId) }))!;
  expect(org.settings.autoTopUp).toEqual({ enabled: true, quantity: 1_000, monthlyLimitUsd: 50 });
  expect((await database.query.creditClaims.findFirst())!.credits).toBe(2_000);
  expect((await database.query.usageCarry.findFirst({ where: (c, { eq }) => eq(c.orgId, orgId) }))!.carryMicroUsd).toBe(0);

  // At most once: a second run refuses and changes nothing.
  expect(await convertCredits(database)).toMatchObject({ done: false, reason: "converted_already" });
  expect((await scan(charged)).credits).toBe(500);

  // Undone before the app ever ran in cents: every amount back, the carry too.
  expect(await revertCredits(database)).toEqual({ done: true });
  expect(await scan(charged)).toMatchObject({ credits: 5, creditsReserved: 25 });
  expect((await database.query.orgBilling.findFirst({ where: (b, { eq }) => eq(b.orgId, orgId) }))!).toMatchObject({ credits: 32, autoTopUp: { enabled: true, threshold: 5, quantity: 10, perMonth: 5 } });
  expect((await database.query.orgs.findFirst({ where: (o, { eq }) => eq(o.id, orgId) }))!.settings.autoTopUp).toEqual({ enabled: true, quantity: 10, monthlyLimitUsd: 50 });
  expect((await database.query.usageCarry.findFirst({ where: (c, { eq }) => eq(c.orgId, orgId) }))!.carryMicroUsd).toBe(400_000);
  expect(await revertCredits(database)).toEqual({ done: false, reason: "not_converted" });

  // A revert never divides an amount written in cents since.
  expect(await convertCredits(database)).toMatchObject({ done: true });
  await database.$client`update org_billing set credits = 3_250 where org_id = ${orgId}`;
  expect(await revertCredits(database)).toEqual({ done: false, reason: "not_whole" });
  expect((await scan(charged)).credits).toBe(500);
});

it("keeps the provider side's journal: a record written once, its steps, and who is not verified", async () => {
  const orgId = (await database.query.orgBilling.findFirst())!.orgId;
  expect(await unswitchedOrgs(database)).toEqual([orgId]);
  const first = await recordCustomerJournal(database, orgId, { total: 32 });
  expect(first).toEqual({ step: "recorded", record: { total: 32 }, error: null });
  // Recording again keeps the first record.
  expect((await recordCustomerJournal(database, orgId, { total: 99 })).record).toEqual({ total: 32 });
  await failCustomerJournal(database, orgId, "stopped");
  expect((await customerJournalSummary(database)).unfinished).toEqual([{ customerId: orgId, step: "recorded", error: "stopped" }]);
  await advanceCustomerJournal(database, orgId, "verified", { total: 3_200 });
  expect(await customerJournalRow(database, orgId)).toEqual({ step: "verified", record: { total: 32 }, error: null });
  expect(await customerJournalSummary(database)).toEqual({ byStep: { verified: 1 }, unfinished: [] });
  expect(await unswitchedOrgs(database)).toEqual([]);
  const [row] = await database.$client<Array<{ log: Array<{ step: string }> }>>`select log from credit_unit_switch where subject = ${orgId}`;
  expect(row!.log.map((l) => l.step)).toEqual(["recorded", "verified"]);
});
