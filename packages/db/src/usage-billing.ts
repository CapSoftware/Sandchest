/**
 * Usage bills, one per scan, and each account's carry under one credit. What a bill says is computed by the
 * caller (`usageBill` in @sandchest/billing); this stores it and moves the carry exactly once per bill, always
 * under a lock on the account's carry row, so two bills of one account never start from the same carry.
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { settleScan as settleScanRow } from "./billing";
import type { Db } from "./client";
import { scanBills, scans, scanUsage, usageCarry, type ScanBillLine, type ScanBillStatus, type UsageKind, type UsageStatus } from "./schema";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type ScanBill = typeof scanBills.$inferSelect;

/** A ledger row as a usage bill reads it. Decimals come back as exact strings. */
export interface LedgerBillRow {
  kind: UsageKind;
  stage: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  seconds: string | null;
  costUsd: string;
  step: string;
  attempt: number;
  status: UsageStatus;
}

/** Every row of a scan's ledger, every attempt and status, in the order it was spent. The bill picks what counts. */
export async function billableUsageRows(database: Db, scanId: string): Promise<LedgerBillRow[]> {
  return database
    .select({
      kind: scanUsage.kind,
      stage: scanUsage.stage,
      inputTokens: scanUsage.inputTokens,
      cachedTokens: scanUsage.cachedTokens,
      outputTokens: scanUsage.outputTokens,
      reasoningTokens: scanUsage.reasoningTokens,
      seconds: scanUsage.seconds,
      costUsd: scanUsage.costUsd,
      step: scanUsage.step,
      attempt: scanUsage.attempt,
      status: scanUsage.status,
    })
    .from(scanUsage)
    .where(eq(scanUsage.scanId, scanId))
    .orderBy(asc(scanUsage.createdAt), asc(scanUsage.id));
}

/** A bill as its caller computed it. The scan's org is filled in here. */
export interface ScanBillDraft {
  status: ScanBillStatus;
  reason?: string | null;
  engine: "classic" | "slice";
  fast?: boolean;
  multiplierThousandths: number;
  creditMicroUsd: number;
  costMicroUsd: number;
  dueMicroUsd: number;
  reservedCredits: number;
  credits: number;
  /** Must be the carry the draft was computed from, as passed to it. A shadow bill may say 0 instead. */
  carryInMicroUsd: number;
  carryOutMicroUsd: number;
  capped: boolean;
  lines: ScanBillLine[];
  settledAt?: Date | null;
}

/** Bills that move the account's carry. A shadow, waived or voided bill is stored without touching it. */
const MOVES_CARRY: readonly ScanBillStatus[] = ["open", "charged"];

/**
 * Stores a scan's bill and moves its account's carry, in one transaction: the carry row is made to exist and
 * locked, `build` computes the bill from the carry read under that lock, the bill is inserted once, and only
 * then does the carry become the bill's carry out. A scan already billed keeps its first bill: `build` is not
 * called again and the carry does not move again. Two scans of one account billed at once take turns on the
 * carry row, so the second is computed from the first's carry out.
 */
export async function writeScanBill(
  database: Db,
  scanId: string,
  build: (carryInMicroUsd: number) => ScanBillDraft | Promise<ScanBillDraft>,
): Promise<{ bill: ScanBill; created: boolean }> {
  return database.transaction(async (tx) => {
    const [scan] = await tx.select({ orgId: scans.orgId }).from(scans).where(eq(scans.id, scanId));
    if (!scan) throw new Error("No such scan to bill");
    await tx.insert(usageCarry).values({ orgId: scan.orgId }).onConflictDoNothing({ target: usageCarry.orgId });
    const [carry] = await tx.select({ microUsd: usageCarry.carryMicroUsd }).from(usageCarry).where(eq(usageCarry.orgId, scan.orgId)).for("update");
    if (!carry) throw new Error("The account's carry row is missing");

    const [existing] = await tx.select().from(scanBills).where(eq(scanBills.scanId, scanId));
    if (existing) return { bill: existing, created: false };

    const draft = await build(carry.microUsd);
    // A shadow bill may be computed from no carry instead: it never moves the account's.
    const fromNoCarry = draft.status === "shadow" && draft.carryInMicroUsd === 0;
    if (draft.carryInMicroUsd !== carry.microUsd && !fromNoCarry) throw new Error("The bill was not computed from the account's carry");
    if (MOVES_CARRY.includes(draft.status)) checkSettlement(draft);

    const [inserted] = await tx
      .insert(scanBills)
      .values({ ...draft, scanId, orgId: scan.orgId })
      .onConflictDoNothing({ target: scanBills.scanId })
      .returning();
    if (!inserted) {
      // Not reached while every writer takes the carry lock first; kept so a bill is never written twice.
      const [first] = await tx.select().from(scanBills).where(eq(scanBills.scanId, scanId));
      return { bill: first!, created: false };
    }
    if (MOVES_CARRY.includes(inserted.status)) {
      await tx.update(usageCarry).set({ carryMicroUsd: inserted.carryOutMicroUsd }).where(eq(usageCarry.orgId, scan.orgId));
    }
    return { bill: inserted, created: true };
  });
}

/**
 * A bill that moves the carry must settle exactly: uncapped, `credits × credit + carry out = due + carry in`
 * with the carry out under one credit; capped, the reserved credits and the carry left as it was.
 */
function checkSettlement(draft: ScanBillDraft): void {
  const credit = BigInt(draft.creditMicroUsd);
  const charged = BigInt(draft.credits) * credit;
  const owed = BigInt(draft.dueMicroUsd) + BigInt(draft.carryInMicroUsd);
  const settles = draft.capped
    ? draft.credits === draft.reservedCredits && draft.carryOutMicroUsd === draft.carryInMicroUsd && charged < owed
    : charged + BigInt(draft.carryOutMicroUsd) === owed && BigInt(draft.carryOutMicroUsd) < credit && draft.credits <= draft.reservedCredits;
  if (!settles) throw new Error("The bill does not settle exactly");
}

export async function scanBill(database: Db, scanId: string): Promise<ScanBill | undefined> {
  const [bill] = await database.select().from(scanBills).where(eq(scanBills.scanId, scanId));
  return bill;
}

/** An account's carry in micro-dollars: 0 before its first bill. */
export async function orgCarry(database: Db, orgId: string): Promise<number> {
  const [row] = await database.select({ microUsd: usageCarry.carryMicroUsd }).from(usageCarry).where(eq(usageCarry.orgId, orgId));
  return row?.microUsd ?? 0;
}

/** An open bill becomes charged, once. False when it was not open. */
export async function markBillCharged(database: Db | Tx, scanId: string): Promise<boolean> {
  const rows = await database
    .update(scanBills)
    .set({ status: "charged", settledAt: sql`now()` })
    .where(and(eq(scanBills.scanId, scanId), eq(scanBills.status, "open")))
    .returning({ scanId: scanBills.scanId });
  return rows.length === 1;
}

/**
 * The account's carry once a bill is withdrawn.
 *
 * Every uncapped bill settles `credits × credit + carry out = due + carry in`, and a capped one leaves the carry
 * as it found it, so along an account's bills: credits charged by the uncapped bills, plus the carry now, equal
 * everything they made due plus the first carry. Removing one bill keeps that true only if the carry moves by
 * `carry in - carry out` of that bill (0 for a capped bill), which is what this returns. It is exact, whatever
 * later bills did with the carry, while the result is from 0 to under one credit. Outside that it cannot be
 * stored, and is held to the edge:
 * - below 0: later bills already charged a credit partly for this bill's carry, so the account paid ahead by
 *   less than one credit. Held at 0, the account keeps that overpayment, under one credit: it cannot be avoided
 *   without a negative carry or refunding part of a credit.
 * - a credit or more: held to one micro-dollar under a credit; we forgive the rest, never the account.
 */
export function carryAfterVoid(carryMicroUsd: number, bill: Pick<ScanBill, "carryInMicroUsd" | "carryOutMicroUsd" | "creditMicroUsd">): number {
  const restored = carryMicroUsd + bill.carryInMicroUsd - bill.carryOutMicroUsd;
  return Math.min(Math.max(restored, 0), bill.creditMicroUsd - 1);
}

/**
 * Withdraws an open bill and gives its carry back (`carryAfterVoid`), in one transaction that takes the
 * account's carry lock before the bill, as `writeScanBill` does. Only an open bill is voided, once. False when
 * there is no open bill for the scan.
 */
export async function voidScanBill(database: Db, scanId: string, reason: string): Promise<boolean> {
  return database.transaction((tx) => voidOpenBill(tx, scanId, reason));
}

async function voidOpenBill(tx: Tx, scanId: string, reason: string): Promise<boolean> {
  const [found] = await tx.select({ orgId: scanBills.orgId }).from(scanBills).where(eq(scanBills.scanId, scanId));
  if (!found) return false;
  const [carry] = await tx.select({ microUsd: usageCarry.carryMicroUsd }).from(usageCarry).where(eq(usageCarry.orgId, found.orgId)).for("update");
  const [voided] = await tx
    .update(scanBills)
    .set({ status: "voided", reason })
    .where(and(eq(scanBills.scanId, scanId), eq(scanBills.status, "open")))
    .returning();
  if (!voided) return false;
  // An open bill moved the carry when it was written, so its row exists.
  if (!carry) throw new Error("The account's carry row is missing");
  await tx.update(usageCarry).set({ carryMicroUsd: carryAfterVoid(carry.microUsd, voided) }).where(eq(usageCarry.orgId, found.orgId));
  return true;
}

/** A waived bill's hold was given back: it stays waived, and says when. Once. False when there is no such bill. */
export async function markWaivedBillSettled(database: Db | Tx, scanId: string): Promise<boolean> {
  const rows = await database
    .update(scanBills)
    .set({ settledAt: sql`now()` })
    .where(and(eq(scanBills.scanId, scanId), eq(scanBills.status, "waived"), isNull(scanBills.settledAt)))
    .returning({ scanId: scanBills.scanId });
  return rows.length === 1;
}

/** Notes on an open bill why its settling needs a look (an expired hold), leaving the rest of it as it is. True only when this call noted it. */
export async function noteBillReason(database: Db, scanId: string, reason: string): Promise<boolean> {
  const rows = await database
    .update(scanBills)
    .set({ reason })
    .where(and(eq(scanBills.scanId, scanId), eq(scanBills.status, "open"), isNull(scanBills.reason)))
    .returning({ scanId: scanBills.scanId });
  return rows.length === 1;
}

/** Why a failed scan's bill was voided. */
export const VOIDED_FAILED = "scan_failed";

/**
 * Settles a usage-billed scan in the database once its hold was confirmed or given back: the scan row moves from
 * reserved to `outcome`, and its bill with it, in one transaction, so the two never disagree. Charged: an open
 * bill becomes charged. Released: an open bill is voided and its carry given back. Either way a waived bill stays
 * waived, settled. A charged, voided or shadow bill is never touched. Nothing moves, the bill included, unless the
 * scan still held its credits: false then, so a retry never voids or restores the carry twice.
 */
export async function settleBilledScan(database: Db, scanId: string, outcome: "charged" | "released", credits = 0): Promise<boolean> {
  return database.transaction(async (tx) => {
    if (!(await settleScanRow(tx, scanId, outcome, credits))) return false;
    if (outcome === "charged") await markBillCharged(tx, scanId);
    else await voidOpenBill(tx, scanId, VOIDED_FAILED);
    await markWaivedBillSettled(tx, scanId);
    return true;
  });
}
