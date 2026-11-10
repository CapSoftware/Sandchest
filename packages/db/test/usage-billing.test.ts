/**
 * Usage bills and carries against a throwaway database on the local Postgres
 * (docker compose -f docker/compose.dev.yml up -d). Skips if it is not running.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  billableUsageRows,
  carryAfterVoid,
  createDb,
  insertUsage,
  lastDeepScanCharges,
  markBillCharged,
  markWaivedBillSettled,
  noteBillReason,
  orgCarry,
  scanBill,
  schema,
  settleBilledScan,
  spendSince,
  upsertInstallation,
  usageHistory,
  voidScanBill,
  writeScanBill,
  type Db,
  type ScanBillDraft,
} from "../src";
import { migrate } from "../src/migrate";

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest";
const NAME = `sandchest_usage_billing_test_${process.pid}`;
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

let installs = 8000;
async function newOrg(): Promise<{ orgId: string; repoId: string }> {
  installs++;
  const { org, repos } = await upsertInstallation(database, installs, { githubAccountId: installs, githubLogin: "acme", type: "Organization" }, [
    { githubRepoId: installs, fullName: "acme/app", private: true, defaultBranch: "main" },
  ]);
  return { orgId: org.id, repoId: repos[0]!.id };
}

async function newScan(org: { orgId: string; repoId: string }): Promise<string> {
  const [scan] = await database.insert(schema.scans).values({ repoId: org.repoId, orgId: org.orgId, kind: "deep", trigger: "manual", headSha: "HEAD", status: "completed" }).returning();
  return scan!.id;
}

/** A made-up credit size, in micro-dollars. */
const CREDIT = 10_000;

/** A bill that settles as the billing package's `usageBill` does: whole credits, the rest carried, held to the reserve. */
function draft(dueMicroUsd: number, carryInMicroUsd: number, extra: Partial<ScanBillDraft> = {}): ScanBillDraft {
  const reservedCredits = extra.reservedCredits ?? 100;
  const owed = dueMicroUsd + carryInMicroUsd;
  const settled = Math.floor(owed / CREDIT);
  const capped = settled > reservedCredits;
  return {
    status: "open",
    engine: "slice",
    multiplierThousandths: 2000,
    creditMicroUsd: CREDIT,
    costMicroUsd: Math.floor(dueMicroUsd / 2),
    dueMicroUsd,
    reservedCredits,
    credits: capped ? reservedCredits : settled,
    carryInMicroUsd,
    carryOutMicroUsd: capped ? carryInMicroUsd : owed % CREDIT,
    capped,
    lines: [{ kind: "model", stage: "hunt", requests: 3, inputTokens: 30, cachedTokens: 10, outputTokens: 5, reasoningTokens: 1, seconds: 0, costMicroUsd: Math.floor(dueMicroUsd / 2), chargeMicroUsd: dueMicroUsd }],
    ...extra,
  };
}

async function billed(scanId: string, due: number, extra: Partial<ScanBillDraft> = {}) {
  return writeScanBill(database, scanId, (carry) => draft(due, carry, extra));
}

describe("billableUsageRows", () => {
  it("every row of the scan, every attempt and status, with what a bill needs, in ledger order", async () => {
    const org = await newOrg();
    const scanId = await newScan(org);
    const other = await newScan(org);
    const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));
    await insertUsage(database, scanId, [
      { kind: "model", stage: "hunt", role: "hunt", inputTokens: 10, cachedTokens: 4, outputTokens: 2, reasoningTokens: 1, costUsd: "0.0000012345", costSource: "provider", step: "hunt-1", attempt: 1, status: "ok", createdAt: at(5) },
      { kind: "sandbox", stage: "sandbox", seconds: "12.250", costUsd: "0.0100000000", costSource: "sandbox", createdAt: at(1) },
      { kind: "model", stage: "hunt", costUsd: "0", costSource: "provider", step: "hunt-1", attempt: 0, status: "failed", createdAt: at(5) },
      { kind: "model", stage: "verify", costUsd: "0", costSource: "provider", step: "verify", status: "unpriced", createdAt: at(9) },
    ]);
    await insertUsage(database, other, [{ kind: "model", stage: "hunt", costUsd: "1", costSource: "provider" }]);
    const rows = await billableUsageRows(database, scanId);
    expect(rows).toEqual([
      { kind: "sandbox", stage: "sandbox", inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0, seconds: "12.250", costUsd: "0.0100000000", step: "execute", attempt: 0, status: "ok" },
      // Same time: in the order written.
      { kind: "model", stage: "hunt", inputTokens: 10, cachedTokens: 4, outputTokens: 2, reasoningTokens: 1, seconds: null, costUsd: "0.0000012345", step: "hunt-1", attempt: 1, status: "ok" },
      { kind: "model", stage: "hunt", inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0, seconds: null, costUsd: "0.0000000000", step: "hunt-1", attempt: 0, status: "failed" },
      { kind: "model", stage: "verify", inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0, seconds: null, costUsd: "0.0000000000", step: "verify", attempt: 0, status: "unpriced" },
    ]);
    expect(await billableUsageRows(database, "00000000-0000-0000-0000-000000000000")).toEqual([]);
  });
});

describe("writeScanBill", () => {
  it("the first bill starts from no carry, is stored, and leaves its carry out", async () => {
    const org = await newOrg();
    const scanId = await newScan(org);
    expect(await orgCarry(database, org.orgId)).toBe(0);
    const seen: number[] = [];
    const { bill, created } = await writeScanBill(database, scanId, (carry) => {
      seen.push(carry);
      return draft(25_000, carry);
    });
    expect(seen).toEqual([0]);
    expect(created).toBe(true);
    expect(bill).toMatchObject({ scanId, orgId: org.orgId, status: "open", reason: null, engine: "slice", fast: false, dueMicroUsd: 25_000, credits: 2, carryInMicroUsd: 0, carryOutMicroUsd: 5_000, capped: false, settledAt: null });
    expect(bill.lines).toEqual(draft(25_000, 0).lines);
    expect(await scanBill(database, scanId)).toEqual(bill);
    expect(await orgCarry(database, org.orgId)).toBe(5_000);
  });

  it("a scan is billed once: a second call returns the first bill, computes nothing and moves the carry once", async () => {
    const org = await newOrg();
    const scanId = await newScan(org);
    const first = await billed(scanId, 13_000);
    let called = false;
    const again = await writeScanBill(database, scanId, (carry) => {
      called = true;
      return draft(99_000, carry);
    });
    expect(called).toBe(false);
    expect(again).toEqual({ bill: first.bill, created: false });
    expect(await orgCarry(database, org.orgId)).toBe(3_000);
  });

  it("the next scan of the account is computed from the carry the last one left", async () => {
    const org = await newOrg();
    const a = await billed(await newScan(org), 13_000);
    const b = await billed(await newScan(org), 8_000);
    expect(a.bill).toMatchObject({ credits: 1, carryInMicroUsd: 0, carryOutMicroUsd: 3_000 });
    expect(b.bill).toMatchObject({ credits: 1, carryInMicroUsd: 3_000, carryOutMicroUsd: 1_000 });
    expect(await orgCarry(database, org.orgId)).toBe(1_000);
    // Another account's carry is its own.
    const other = await newOrg();
    expect((await billed(await newScan(other), 1_000)).bill.carryInMicroUsd).toBe(0);
    expect(await orgCarry(database, org.orgId)).toBe(1_000);
  });

  it("a capped bill leaves the carry as it was", async () => {
    const org = await newOrg();
    await billed(await newScan(org), 4_000);
    const { bill } = await billed(await newScan(org), 50_000, { reservedCredits: 3 });
    expect(bill).toMatchObject({ credits: 3, capped: true, carryInMicroUsd: 4_000, carryOutMicroUsd: 4_000 });
    expect(await orgCarry(database, org.orgId)).toBe(4_000);
  });

  it("shadow and waived bills are stored without moving the carry", async () => {
    const org = await newOrg();
    await billed(await newScan(org), 2_000);
    for (const status of ["shadow", "waived"] as const) {
      const scanId = await newScan(org);
      const { bill, created } = await billed(scanId, 7_500, { status, reason: status === "waived" ? "ledger_untrusted" : null });
      expect(created).toBe(true);
      expect(bill).toMatchObject({ status, carryInMicroUsd: 2_000, carryOutMicroUsd: 9_500 });
      expect(await orgCarry(database, org.orgId)).toBe(2_000);
    }
  });

  it("a shadow bill may be computed from no carry, whatever the account's; other bills may not", async () => {
    const org = await newOrg();
    await billed(await newScan(org), 6_000);
    const shadow = await newScan(org);
    const { bill, created } = await writeScanBill(database, shadow, () => draft(7_500, 0, { status: "shadow" }));
    expect(created).toBe(true);
    expect(bill).toMatchObject({ status: "shadow", carryInMicroUsd: 0, carryOutMicroUsd: 7_500 });
    expect(await orgCarry(database, org.orgId)).toBe(6_000);
    // Neither another carry, nor no carry for a bill that is not shadow.
    await expect(writeScanBill(database, await newScan(org), () => draft(7_500, 1_000, { status: "shadow" }))).rejects.toThrow("not computed from the account's carry");
    for (const status of ["open", "waived"] as const) {
      const scanId = await newScan(org);
      await expect(writeScanBill(database, scanId, () => draft(7_500, 0, { status }))).rejects.toThrow("not computed from the account's carry");
      expect(await scanBill(database, scanId)).toBeUndefined();
    }
    expect(await orgCarry(database, org.orgId)).toBe(6_000);
  });

  it("refuses a bill not computed from the carry it was given, or one that does not settle, and stores nothing", async () => {
    const org = await newOrg();
    await billed(await newScan(org), 6_000);
    const scanId = await newScan(org);
    const wrong: ((carry: number) => ScanBillDraft)[] = [
      () => draft(1_000, 0),
      (carry) => ({ ...draft(1_000, carry), carryOutMicroUsd: 0 }),
      (carry) => ({ ...draft(31_000, carry), credits: 2 }),
      (carry) => ({ ...draft(31_000, carry), credits: 4, carryOutMicroUsd: 0 }),
      // Capped (47,000 owed is 4 credits, 3 reserved) but the carry moved, or fewer credits than reserved.
      (carry) => ({ ...draft(41_000, carry, { reservedCredits: 3 }), carryOutMicroUsd: 7_000 }),
      (carry) => ({ ...draft(41_000, carry, { reservedCredits: 3 }), credits: 2 }),
      // Not capped, but more credits than were reserved.
      (carry) => ({ ...draft(31_000, carry), reservedCredits: 2 }),
    ];
    for (const build of wrong) {
      await expect(writeScanBill(database, scanId, build)).rejects.toThrow();
      expect(await scanBill(database, scanId)).toBeUndefined();
      expect(await orgCarry(database, org.orgId)).toBe(6_000);
    }
    await expect(writeScanBill(database, "00000000-0000-0000-0000-000000000000", (carry) => draft(1, carry))).rejects.toThrow("No such scan");
  });

  it("two scans of one account billed at once take turns: the second starts from the first's carry out", async () => {
    for (const priorBill of [false, true]) {
      const org = await newOrg();
      if (priorBill) await billed(await newScan(org), 4_000);
      const [a, b] = [await newScan(org), await newScan(org)];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => (entered = resolve));
      const first = writeScanBill(database, a, async (carry) => {
        entered();
        await gate;
        return draft(17_000, carry);
      });
      await inside;
      let secondCarry: number | undefined;
      const second = writeScanBill(database, b, (carry) => {
        secondCarry = carry;
        return draft(9_000, carry);
      });
      await Bun.sleep(200);
      // Still waiting on the first's lock.
      expect(secondCarry).toBeUndefined();
      release();
      const [one, two] = await Promise.all([first, second]);
      expect(secondCarry).toBe(one.bill.carryOutMicroUsd);
      expect(two.bill.carryInMicroUsd).toBe(one.bill.carryOutMicroUsd);
      expect(await orgCarry(database, org.orgId)).toBe(two.bill.carryOutMicroUsd);
      expect(two.bill.carryOutMicroUsd).toBe(((priorBill ? 4_000 : 0) + 17_000 + 9_000) % CREDIT);
    }
  });

  it("one scan billed twice at once is billed once", async () => {
    const org = await newOrg();
    const scanId = await newScan(org);
    const results = await Promise.all(Array.from({ length: 4 }, () => billed(scanId, 12_000)));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    for (const r of results) expect(r.bill).toEqual(results[0]!.bill);
    expect(await orgCarry(database, org.orgId)).toBe(2_000);
  });
});

describe("markBillCharged", () => {
  it("open to charged, once, with when", async () => {
    const org = await newOrg();
    const scanId = await newScan(org);
    await billed(scanId, 10_000);
    expect(await markBillCharged(database, scanId)).toBe(true);
    expect(await markBillCharged(database, scanId)).toBe(false);
    const bill = await scanBill(database, scanId);
    expect(bill?.status).toBe("charged");
    expect(bill?.settledAt).toBeInstanceOf(Date);
    expect(await markBillCharged(database, await newScan(org))).toBe(false);
    // Only open bills: a shadow bill is never charged.
    const shadow = await newScan(org);
    await billed(shadow, 1_000, { status: "shadow" });
    expect(await markBillCharged(database, shadow)).toBe(false);
  });
});

describe("voidScanBill", () => {
  it("the last bill voided gives back exactly the carry it found", async () => {
    const org = await newOrg();
    await billed(await newScan(org), 7_000);
    // Takes the 7,000 carried into a whole credit: 7,000 + 5,000 = 1 credit and 2,000 carried.
    const scanId = await newScan(org);
    await billed(scanId, 5_000);
    expect(await orgCarry(database, org.orgId)).toBe(2_000);
    expect(await voidScanBill(database, scanId, "scan_failed")).toBe(true);
    expect(await orgCarry(database, org.orgId)).toBe(7_000);
    expect(await scanBill(database, scanId)).toMatchObject({ status: "voided", reason: "scan_failed" });
    // Once.
    expect(await voidScanBill(database, scanId, "again")).toBe(false);
    expect(await orgCarry(database, org.orgId)).toBe(7_000);
    expect((await scanBill(database, scanId))?.reason).toBe("scan_failed");
  });

  it("a bill voided under later ones moves the carry by what it moved it", async () => {
    const org = await newOrg();
    const scanId = await newScan(org);
    await billed(scanId, 3_000); // carry 0 -> 3,000
    await billed(await newScan(org), 4_000); // 3,000 -> 7,000
    expect(await voidScanBill(database, scanId, "scan_failed")).toBe(true);
    expect(await orgCarry(database, org.orgId)).toBe(4_000);
  });

  it("never below nothing, never a credit or more", async () => {
    // Below: the later bill already charged a credit partly for the voided bill's carry.
    const org = await newOrg();
    const scanId = await newScan(org);
    await billed(scanId, 6_000); // 0 -> 6,000
    await billed(await newScan(org), 5_000); // 11,000: 1 credit, 1,000 carried
    expect(await voidScanBill(database, scanId, "scan_failed")).toBe(true);
    expect(await orgCarry(database, org.orgId)).toBe(0);
    // Above: the voided bill had taken a large carry into a credit, and a later one carried a lot again.
    const other = await newOrg();
    await billed(await newScan(other), 9_000); // 0 -> 9,000
    const taken = await newScan(other);
    await billed(taken, 2_000); // 11,000: 1 credit, 1,000 carried
    await billed(await newScan(other), 8_000); // 9,000
    expect(await voidScanBill(database, taken, "scan_failed")).toBe(true);
    expect(await orgCarry(database, other.orgId)).toBe(CREDIT - 1);
  });

  it("a capped bill voided leaves the carry as it is", async () => {
    const org = await newOrg();
    await billed(await newScan(org), 4_000);
    const scanId = await newScan(org);
    await billed(scanId, 90_000, { reservedCredits: 2 });
    await billed(await newScan(org), 1_000);
    expect(await voidScanBill(database, scanId, "scan_failed")).toBe(true);
    expect(await orgCarry(database, org.orgId)).toBe(5_000);
  });

  it("only from open: charged, shadow, waived, missing and unbilled scans are left alone", async () => {
    const org = await newOrg();
    const charged = await newScan(org);
    await billed(charged, 3_000);
    await markBillCharged(database, charged);
    const shadow = await newScan(org);
    await billed(shadow, 3_000, { status: "shadow" });
    const waived = await newScan(org);
    await billed(waived, 3_000, { status: "waived", reason: "ledger_untrusted" });
    for (const scanId of [charged, shadow, waived, await newScan(org), "00000000-0000-0000-0000-000000000000"]) {
      expect(await voidScanBill(database, scanId, "scan_failed")).toBe(false);
    }
    expect(await orgCarry(database, org.orgId)).toBe(3_000);
    expect((await scanBill(database, charged))?.status).toBe("charged");
    expect((await scanBill(database, waived))?.reason).toBe("ledger_untrusted");
  });
});

describe("settleBilledScan", () => {
  const reserve = (scanId: string) => database.$client`update scans set billing = 'reserved', credits_reserved = 100, credits = 7 where id = ${scanId}`;
  const scanRow = async (scanId: string) => (await database.query.scans.findFirst({ where: (scans, { eq }) => eq(scans.id, scanId) }))!;

  it("charged: the scan row and an open bill move together, once; the carry stays", async () => {
    const org = await newOrg();
    const scanId = await newScan(org);
    const { bill } = await billed(scanId, 123_456, { reservedCredits: 100 });
    await reserve(scanId);
    const carry = await orgCarry(database, org.orgId);
    expect(await settleBilledScan(database, scanId, "charged", bill.credits)).toBe(true);
    expect(await scanRow(scanId)).toMatchObject({ billing: "charged", credits: bill.credits });
    const charged = (await scanBill(database, scanId))!;
    expect(charged).toEqual({ ...bill, status: "charged", settledAt: expect.any(Date) });
    expect(await settleBilledScan(database, scanId, "charged", bill.credits)).toBe(false);
    expect(await settleBilledScan(database, scanId, "released")).toBe(false);
    expect(await scanBill(database, scanId)).toEqual(charged);
    expect(await scanRow(scanId)).toMatchObject({ billing: "charged", credits: bill.credits });
    expect(await orgCarry(database, org.orgId)).toBe(carry);
  });

  it("released: an open bill is voided and its carry given back, once", async () => {
    const org = await newOrg();
    await database.insert(schema.usageCarry).values({ orgId: org.orgId, carryMicroUsd: 4_000 });
    const scanId = await newScan(org);
    const { bill } = await billed(scanId, 23_456);
    await reserve(scanId);
    expect(await orgCarry(database, org.orgId)).toBe(bill.carryOutMicroUsd);
    expect(await settleBilledScan(database, scanId, "released")).toBe(true);
    expect(await scanRow(scanId)).toMatchObject({ billing: "released", credits: 0 });
    expect(await scanBill(database, scanId)).toEqual({ ...bill, status: "voided", reason: "scan_failed" });
    expect(await orgCarry(database, org.orgId)).toBe(4_000);
    // Run again after the carry moved on: nothing is given back twice.
    await database.$client`update usage_carry set carry_micro_usd = 9 where org_id = ${org.orgId}`;
    expect(await settleBilledScan(database, scanId, "released")).toBe(false);
    expect(await orgCarry(database, org.orgId)).toBe(9);
  });

  it("nothing moves, the bill included, for a scan no longer reserved", async () => {
    const org = await newOrg();
    const scanId = await newScan(org);
    const { bill } = await billed(scanId, 23_456);
    await database.$client`update scans set billing = 'charged' where id = ${scanId}`;
    const carry = await orgCarry(database, org.orgId);
    expect(await settleBilledScan(database, scanId, "released")).toBe(false);
    expect(await scanBill(database, scanId)).toEqual(bill);
    expect(await orgCarry(database, org.orgId)).toBe(carry);
  });

  it("a waived bill stays waived and is settled either way; a shadow bill is never touched", async () => {
    const org = await newOrg();
    for (const outcome of ["charged", "released"] as const) {
      const scanId = await newScan(org);
      const { bill } = await writeScanBill(database, scanId, (carry) => ({ ...draft(5_000, carry), status: "waived", reason: "unpriced", credits: 0, carryOutMicroUsd: carry }));
      await reserve(scanId);
      expect(await settleBilledScan(database, scanId, outcome)).toBe(true);
      expect(await scanBill(database, scanId)).toEqual({ ...bill, settledAt: expect.any(Date) });
      expect(await markWaivedBillSettled(database, scanId)).toBe(false);
    }
    const shadowed = await newScan(org);
    const { bill: shadow } = await billed(shadowed, 5_000, { status: "shadow" });
    await reserve(shadowed);
    expect(await settleBilledScan(database, shadowed, "released")).toBe(true);
    expect(await scanBill(database, shadowed)).toEqual(shadow);
    expect(await markWaivedBillSettled(database, shadowed)).toBe(false);
    expect(await noteBillReason(database, shadowed, "hold_expired")).toBe(false);
    expect(await scanBill(database, shadowed)).toEqual(shadow);
  });

  it("noteBillReason notes an open bill once and leaves the rest of it as it is", async () => {
    const org = await newOrg();
    const scanId = await newScan(org);
    const { bill } = await billed(scanId, 23_456);
    expect(await noteBillReason(database, scanId, "hold_expired")).toBe(true);
    expect(await noteBillReason(database, scanId, "hold_expired")).toBe(false);
    expect(await scanBill(database, scanId)).toEqual({ ...bill, reason: "hold_expired" });
  });
});

describe("carryAfterVoid", () => {
  const bill = (carryInMicroUsd: number, carryOutMicroUsd: number) => ({ carryInMicroUsd, carryOutMicroUsd, creditMicroUsd: CREDIT });

  test("moves the carry back by what the bill moved it, held from 0 to under a credit", () => {
    expect(carryAfterVoid(2_000, bill(7_000, 2_000))).toBe(7_000);
    expect(carryAfterVoid(7_000, bill(3_000, 7_000))).toBe(3_000);
    expect(carryAfterVoid(1_000, bill(0, 6_000))).toBe(0);
    expect(carryAfterVoid(9_000, bill(9_000, 1_000))).toBe(CREDIT - 1);
    expect(carryAfterVoid(4_321, bill(5_000, 5_000))).toBe(4_321);
  });

  test("over many accounts' bills, voiding any one keeps credits charged plus carry equal to what is due, whenever that fits", () => {
    let state = 7;
    const next = (below: number) => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state % below;
    };
    let exact = 0;
    for (let account = 0; account < 3000; account++) {
      const bills: ScanBillDraft[] = [];
      let carry = 0;
      for (let i = 0, n = 1 + next(8); i < n; i++) {
        const bill = draft(next(4 * CREDIT), carry, { reservedCredits: next(5) });
        bills.push(bill);
        carry = bill.carryOutMicroUsd;
      }
      const voided = next(bills.length);
      const after = carryAfterVoid(carry, bills[voided]!);
      expect(after).toBeGreaterThanOrEqual(0);
      expect(after).toBeLessThan(CREDIT);
      const standing = bills.filter((b, i) => i !== voided && !b.capped);
      const charged = standing.reduce((sum, b) => sum + b.credits * CREDIT, 0);
      const due = standing.reduce((sum, b) => sum + b.dueMicroUsd, 0);
      const unclamped = carry + bills[voided]!.carryInMicroUsd - bills[voided]!.carryOutMicroUsd;
      if (unclamped >= 0 && unclamped < CREDIT) {
        exact++;
        expect(charged + after).toBe(due);
      } else {
        // Held at an edge: below, the account keeps under one credit's overpayment; above, we forgive the rest.
        expect(after).toBe(unclamped < 0 ? 0 : CREDIT - 1);
        expect(Math.abs(unclamped - after)).toBeLessThan(CREDIT);
      }
      // The last bill voided: exactly the carry it found.
      if (voided === bills.length - 1) expect(after).toBe(bills[voided]!.carryInMicroUsd);
    }
    expect(exact).toBeGreaterThan(1000);
  });
});

describe("constraints", () => {
  it("a billed scan, and an org with a bill, cannot be deleted; an org's carry goes with it", async () => {
    const org = await newOrg();
    const scanId = await newScan(org);
    await billed(scanId, 1_000);
    await expect(database.$client`delete from scans where id = ${scanId}`).rejects.toThrow();
    await expect(database.$client`delete from orgs where id = ${org.orgId}`).rejects.toThrow();
    expect(await scanBill(database, scanId)).toBeDefined();
    // An org with only a carry row (its bills gone some other way) takes the row with it.
    const bare = await newOrg();
    await database.insert(schema.usageCarry).values({ orgId: bare.orgId, carryMicroUsd: 5 });
    await database.$client`delete from orgs where id = ${bare.orgId}`;
    expect(await orgCarry(database, bare.orgId)).toBe(0);
  });

  it("the database refuses a negative carry, more credits than reserved, a bad status and a credit worth nothing", async () => {
    const refused = (query: PromiseLike<unknown>) => expect((async () => void (await query))()).rejects.toThrow();
    const org = await newOrg();
    await refused(database.insert(schema.usageCarry).values({ orgId: org.orgId, carryMicroUsd: -1 }));
    const scanId = await newScan(org);
    const row = { ...draft(1_000, 0, { status: "shadow" }), scanId, orgId: org.orgId };
    await refused(database.insert(schema.scanBills).values({ ...row, credits: 5, reservedCredits: 4 }));
    await refused(database.insert(schema.scanBills).values({ ...row, status: "paid" as "open" }));
    await refused(database.insert(schema.scanBills).values({ ...row, creditMicroUsd: 0 }));
    await refused(database.insert(schema.scanBills).values({ ...row, carryOutMicroUsd: -1 }));
    expect(await scanBill(database, scanId)).toBeUndefined();
    // The same row, valid, is stored.
    await database.insert(schema.scanBills).values(row);
    expect(await scanBill(database, scanId)).toMatchObject({ status: "shadow" });
  });
});

describe("usageHistory", () => {
  let people = 0;
  /** A person who can see the given repositories, as the dashboard records it. */
  async function person(repoIds: string[]): Promise<string> {
    people++;
    const [user] = await database.insert(schema.users).values({ name: "Pat", email: `pat${people}@example.com` }).returning();
    if (repoIds.length > 0) await database.insert(schema.permissionCache).values(repoIds.map((repoId) => ({ userId: user!.id, repoId, permission: "write" as const })));
    return user!.id;
  }

  /** A bill stored as it stands, made `minutesAgo` minutes ago. */
  async function stored(org: { orgId: string; repoId: string }, status: ScanBillDraft["status"], minutesAgo: number, extra: { kind?: "deep" | "pr_review"; prNumber?: number; credits?: number } = {}) {
    const [scan] = await database
      .insert(schema.scans)
      .values({ repoId: org.repoId, orgId: org.orgId, kind: extra.kind ?? "deep", trigger: "manual", headSha: "HEAD", status: "completed", prNumber: extra.prNumber ?? null })
      .returning();
    const credits = extra.credits ?? 3;
    await database.insert(schema.scanBills).values({ ...draft(credits * CREDIT, 0, { status }), credits, scanId: scan!.id, orgId: org.orgId, createdAt: new Date(Date.now() - minutesAgo * 60_000) });
    return scan!.id;
  }

  it("charged and waived bills only, newest first, with the scan and repository they belong to", async () => {
    const org = await newOrg();
    const userId = await person([org.repoId]);
    const charged = await stored(org, "charged", 30, { credits: 7 });
    const waived = await stored(org, "waived", 20, { kind: "pr_review", prNumber: 12, credits: 0 });
    await stored(org, "open", 10);
    await stored(org, "voided", 5);
    await stored(org, "shadow", 1);
    const rows = await usageHistory(database, userId, org.orgId);
    expect(rows.map((row) => row.scanId)).toEqual([waived, charged]);
    expect(rows[0]).toMatchObject({ status: "waived", credits: 0, kind: "pr_review", prNumber: 12, repoFullName: "acme/app" });
    expect(rows[1]).toMatchObject({ status: "charged", credits: 7, kind: "deep", prNumber: null, repoFullName: "acme/app" });
    expect(rows[1]!.billedAt).toBeInstanceOf(Date);
    // Never a cost, a multiplier or an amount of money.
    expect(Object.keys(rows[0]!).sort()).toEqual(["billedAt", "credits", "kind", "prNumber", "repoFullName", "scanId", "status"]);
  });

  it("only the account asked for, and only repositories the person can see; at most `limit`", async () => {
    const org = await newOrg();
    const other = await newOrg();
    const [hidden] = await database.insert(schema.repos).values({ orgId: org.orgId, githubRepoId: 990_000 + installs, fullName: "acme/hidden", private: true, defaultBranch: "main" }).returning();
    const userId = await person([org.repoId, other.repoId]);
    const mine = await Promise.all([1, 2, 3].map((minutes) => stored(org, "charged", minutes)));
    await stored({ orgId: org.orgId, repoId: hidden!.id }, "charged", 0);
    await stored(other, "charged", 0);
    expect((await usageHistory(database, userId, org.orgId)).map((row) => row.scanId)).toEqual(mine);
    expect((await usageHistory(database, userId, org.orgId, 2)).map((row) => row.scanId)).toEqual(mine.slice(0, 2));
    // Someone who can see none of its repositories sees none of its bills.
    expect(await usageHistory(database, await person([]), org.orgId)).toEqual([]);
    // An account with no bills has no history.
    expect(await usageHistory(database, userId, (await newOrg()).orgId)).toEqual([]);
  });
});

describe("lastDeepScanCharges", () => {
  /** A scan made `minutesAgo` minutes ago, with a bill of `status` when one is given. */
  async function scanned(org: { orgId: string; repoId: string }, minutesAgo: number, bill?: { status: ScanBillDraft["status"]; credits: number }, scan: { kind?: "deep" | "pr_review"; status?: "completed" | "failed" | "running" } = {}) {
    const [row] = await database
      .insert(schema.scans)
      .values({ repoId: org.repoId, orgId: org.orgId, kind: scan.kind ?? "deep", trigger: "manual", headSha: "HEAD", status: scan.status ?? "completed", createdAt: new Date(Date.now() - minutesAgo * 60_000) })
      .returning();
    if (bill) await database.insert(schema.scanBills).values({ ...draft(bill.credits * CREDIT, 0, { status: bill.status }), credits: bill.credits, scanId: row!.id, orgId: org.orgId });
  }

  it("the latest finished deep scan's charge, and nothing for a repository whose latest was not charged from usage", async () => {
    const charged = await newOrg();
    await scanned(charged, 90, { status: "charged", credits: 30 });
    await scanned(charged, 30, { status: "charged", credits: 45 });
    // Newer, but not finished deep scans: a review, a failed scan and one still running.
    await scanned(charged, 20, { status: "charged", credits: 2 }, { kind: "pr_review" });
    await scanned(charged, 10, { status: "voided", credits: 0 }, { status: "failed" });
    await scanned(charged, 5, undefined, { status: "running" });

    // Its latest finished deep scan was priced by size: no bill, so the older bill is not what it last cost.
    const tiered = await newOrg();
    await scanned(tiered, 60, { status: "charged", credits: 70 });
    await scanned(tiered, 10);
    const waived = await newOrg();
    await scanned(waived, 10, { status: "waived", credits: 0 });
    const open = await newOrg();
    await scanned(open, 10, { status: "open", credits: 30 });
    const shadow = await newOrg();
    await scanned(shadow, 10, { status: "shadow", credits: 30 });
    const never = await newOrg();

    const charges = await lastDeepScanCharges(database, [charged, tiered, waived, open, shadow, never].map((org) => org.repoId));
    expect([...charges]).toEqual([[charged.repoId, 45]]);
    // Only the repositories asked for.
    expect(await lastDeepScanCharges(database, [never.repoId])).toEqual(new Map());
    expect(await lastDeepScanCharges(database, [])).toEqual(new Map());
  });
});

describe("spendSince", () => {
  it("sums every account's rows of every status from the bound on, and nothing before it", async () => {
    // A window far from every other test's rows.
    const bound = new Date(Date.UTC(2099, 0, 1));
    const after = (ms: number) => new Date(bound.getTime() + ms);
    expect(await spendSince(database, bound)).toBe("0");
    const first = await newScan(await newOrg());
    const second = await newScan(await newOrg());
    await insertUsage(database, first, [
      { kind: "model", stage: "hunt", costUsd: "0.0000000001", costSource: "provider", status: "ok", createdAt: bound },
      { kind: "model", stage: "hunt", costUsd: "0.25", costSource: "provider", status: "aborted", createdAt: after(1) },
      { kind: "sandbox", stage: "sandbox", costUsd: "1.5", costSource: "sandbox", createdAt: after(60_000) },
      // Before the bound: not counted.
      { kind: "model", stage: "hunt", costUsd: "100", costSource: "provider", createdAt: after(-1) },
    ]);
    await insertUsage(database, second, [
      { kind: "model", stage: "verify", costUsd: "0.125", costSource: "provider", status: "failed", createdAt: after(5) },
      { kind: "model", stage: "verify", costUsd: "0", costSource: "provider", status: "unpriced", createdAt: after(6) },
    ]);
    await database.$client`update scan_usage set status = 'started' where scan_id = ${second} and status = 'failed'`;
    expect(await spendSince(database, bound)).toBe("1.8750000001");
    expect(await spendSince(database, after(2))).toBe("1.6250000000");
    expect(await spendSince(database, after(60_001))).toBe("0");
  });
});
