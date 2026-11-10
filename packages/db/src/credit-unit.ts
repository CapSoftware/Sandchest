/**
 * The database side of the one-time switch from a dollar credit to a cent credit (see the runbook in
 * `apps/web/scripts/credit-unit-switch.ts`), and the journal the provider side keeps here.
 *
 * The conversion is one transaction, run by `credit-unit-cli.ts` and never by a migration: every amount of credits
 * becomes 100 times as many, every account's usage carry goes to 0, and a `database` row in `credit_unit_switch`
 * records it, so it runs at most once. Usage bills keep their own credit size (`credit_micro_usd`) and are not
 * touched, nor is the usage ledger (dollars, not credits).
 */
import { and, count, eq, notInArray, sql } from "drizzle-orm";
import type { Db } from "./client";
import { creditClaims, creditUnitSwitch, orgBilling, orgs, scans, usageCarry } from "./schema";

/** Credits per credit after the switch. */
export const CREDIT_UNIT_FACTOR = 100;
const MAX_INT = 2_147_483_647;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * How many scans hold credits now. The switch waits for 0: a hold taken in dollars must be settled in dollars.
 * A free scan is marked `reserved` with 0 credits while it runs (recon, fix checks, a review of nothing) and holds
 * nothing in Autumn, so it is not counted: free scans keep running while billing is frozen, and counting them
 * would never let the count reach 0.
 */
export async function heldCreditScans(database: Db | Tx): Promise<number> {
  const [row] = await database.select({ n: count() }).from(scans).where(and(eq(scans.billing, "reserved"), sql`${scans.creditsReserved} > 0`));
  return row?.n ?? 0;
}

// ---- The provider side's journal ---------------------------------------------

export interface CustomerJournalRow {
  step: string;
  record: unknown;
  error: string | null;
}

export async function customerJournalRow(database: Db, customerId: string): Promise<CustomerJournalRow | undefined> {
  const [row] = await database
    .select({ step: creditUnitSwitch.step, record: creditUnitSwitch.record, error: creditUnitSwitch.error })
    .from(creditUnitSwitch)
    .where(and(eq(creditUnitSwitch.kind, "customer"), eq(creditUnitSwitch.subject, customerId)));
  return row;
}

/** Stores a customer's record at step `recorded` unless it has a row, and returns the row either way: a record is written once. */
export async function recordCustomerJournal(database: Db, customerId: string, record: unknown): Promise<CustomerJournalRow> {
  await database
    .insert(creditUnitSwitch)
    .values({ kind: "customer", subject: customerId, step: "recorded", record, log: [{ step: "recorded", at: new Date().toISOString() }] })
    .onConflictDoNothing();
  return (await customerJournalRow(database, customerId))!;
}

export async function advanceCustomerJournal(database: Db, customerId: string, step: string, result?: unknown): Promise<void> {
  await database
    .update(creditUnitSwitch)
    .set({
      step,
      error: null,
      ...(result !== undefined && { result }),
      log: sql`${creditUnitSwitch.log} || ${JSON.stringify([{ step, at: new Date().toISOString() }])}::jsonb`,
    })
    .where(and(eq(creditUnitSwitch.kind, "customer"), eq(creditUnitSwitch.subject, customerId)));
}

export async function failCustomerJournal(database: Db, customerId: string, error: string): Promise<void> {
  await database
    .update(creditUnitSwitch)
    .set({ error: error.slice(0, 2_000) })
    .where(and(eq(creditUnitSwitch.kind, "customer"), eq(creditUnitSwitch.subject, customerId)));
}

/** Every customer the provider side has a row for. */
export async function customerJournalIds(database: Db): Promise<string[]> {
  const rows = await database.select({ id: creditUnitSwitch.subject }).from(creditUnitSwitch).where(eq(creditUnitSwitch.kind, "customer"));
  return rows.map((r) => r.id);
}

/** Customers by step, and the ones not yet verified with why they stopped. */
export async function customerJournalSummary(database: Db): Promise<{ byStep: Record<string, number>; unfinished: Array<{ customerId: string; step: string; error: string | null }> }> {
  const rows = await database.select({ step: creditUnitSwitch.step, n: count() }).from(creditUnitSwitch).where(eq(creditUnitSwitch.kind, "customer")).groupBy(creditUnitSwitch.step);
  const unfinished = await database
    .select({ customerId: creditUnitSwitch.subject, step: creditUnitSwitch.step, error: creditUnitSwitch.error })
    .from(creditUnitSwitch)
    .where(and(eq(creditUnitSwitch.kind, "customer"), notInArray(creditUnitSwitch.step, ["verified", "top_up_restored"])));
  return { byStep: Object.fromEntries(rows.map((r) => [r.step, r.n])), unfinished };
}

/** Orgs with a plan or credits whose billing customer the provider side has not verified: the conversion waits for none. */
export async function unswitchedOrgs(database: Db): Promise<string[]> {
  const rows = await database
    .select({ orgId: orgBilling.orgId })
    .from(orgBilling)
    .where(
      sql`(${orgBilling.planId} is not null or ${orgBilling.credits} <> 0) and not exists (
        select 1 from ${creditUnitSwitch} j where j.kind = 'customer' and j.subject = ${orgBilling.orgId}::text and j.step in ('verified', 'top_up_restored'))`,
    );
  return rows.map((r) => r.orgId);
}

// ---- The conversion --------------------------------------------------------------

/** What the conversion changes, counted before it does. Amounts are sums of credits; carries are micro-dollars. */
export interface ConversionPlan {
  scansCredits: { rows: number; sum: number; max: number };
  scansReserved: { rows: number; sum: number; max: number };
  creditClaims: { rows: number; sum: number; max: number };
  orgBillingCredits: { rows: number; sum: number; max: number };
  orgBillingAutoTopUp: { rows: number };
  orgSettingsAutoTopUp: { rows: number };
  /** Every carry above 0: each is put back to 0. */
  carries: Array<{ orgId: string; microUsd: number }>;
  heldScans: number;
  marker: "none" | "converted" | "reverted";
}

const amounts = (rows: Array<{ rows: number; sum: string | number | null; max: number | null }>) => ({ rows: Number(rows[0]?.rows ?? 0), sum: Number(rows[0]?.sum ?? 0), max: Number(rows[0]?.max ?? 0) });

async function marker(database: Db | Tx): Promise<{ step: string; record: unknown } | undefined> {
  const [row] = await database
    .select({ step: creditUnitSwitch.step, record: creditUnitSwitch.record })
    .from(creditUnitSwitch)
    .where(and(eq(creditUnitSwitch.kind, "database"), eq(creditUnitSwitch.subject, "credits")));
  return row;
}


async function plan(database: Db | Tx): Promise<ConversionPlan> {
  const [scansCredits, scansReserved, claims, billing, billingTopUp, settingsTopUp, carries, held, mark] = await Promise.all([
    database.select({ rows: count(), sum: sql<string>`sum(${scans.credits})`, max: sql<number>`max(${scans.credits})` }).from(scans).where(sql`${scans.credits} <> 0`),
    database.select({ rows: count(), sum: sql<string>`sum(${scans.creditsReserved})`, max: sql<number>`max(${scans.creditsReserved})` }).from(scans).where(sql`${scans.creditsReserved} <> 0`),
    database.select({ rows: count(), sum: sql<string>`sum(${creditClaims.credits})`, max: sql<number>`max(${creditClaims.credits})` }).from(creditClaims).where(sql`${creditClaims.credits} <> 0`),
    database.select({ rows: count(), sum: sql<string>`sum(${orgBilling.credits})`, max: sql<number>`max(${orgBilling.credits})` }).from(orgBilling).where(sql`${orgBilling.credits} <> 0`),
    database.select({ rows: count() }).from(orgBilling).where(sql`jsonb_typeof(${orgBilling.autoTopUp}) = 'object'`),
    database.select({ rows: count() }).from(orgs).where(sql`jsonb_typeof(${orgs.settings} -> 'autoTopUp' -> 'quantity') = 'number'`),
    database.select({ orgId: usageCarry.orgId, microUsd: usageCarry.carryMicroUsd }).from(usageCarry).where(sql`${usageCarry.carryMicroUsd} <> 0`),
    heldCreditScans(database).then((n) => [{ n }]),
    marker(database),
  ]);
  return {
    scansCredits: amounts(scansCredits),
    scansReserved: amounts(scansReserved),
    creditClaims: amounts(claims),
    orgBillingCredits: amounts(billing),
    orgBillingAutoTopUp: { rows: billingTopUp[0]?.rows ?? 0 },
    orgSettingsAutoTopUp: { rows: settingsTopUp[0]?.rows ?? 0 },
    carries,
    heldScans: held[0]?.n ?? 0,
    marker: mark ? (mark.step as "converted" | "reverted") : "none",
  };
}

/** What the conversion would change now. Reads only. */
export function conversionPlan(database: Db): Promise<ConversionPlan> {
  return plan(database);
}

export type ConversionOutcome = { done: true; plan: ConversionPlan } | { done: false; reason: "converted_already" | "held_credits" | "too_large"; plan: ConversionPlan };

/** The tables the conversion writes, locked against writers (readers carry on) for the few seconds it takes. */
const LOCK = sql`lock table ${scans}, ${orgBilling}, ${creditClaims}, ${usageCarry}, ${orgs}, ${creditUnitSwitch} in exclusive mode`;

/**
 * Multiplies every amount of credits by 100 and puts every usage carry back to 0, in one transaction that also
 * writes the marker: it runs at most once, and a crash anywhere leaves nothing changed. Refuses (changing nothing)
 * if it ran already, if any scan holds credits, or if an amount would not fit.
 */
export async function convertCredits(database: Db): Promise<ConversionOutcome> {
  return database.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx.execute(LOCK);
    const before = await plan(tx);
    if (before.marker === "converted") return { done: false, reason: "converted_already", plan: before };
    if (before.heldScans > 0) return { done: false, reason: "held_credits", plan: before };
    const largest = Math.max(before.scansCredits.max, before.scansReserved.max, before.creditClaims.max, before.orgBillingCredits.max);
    if (largest * CREDIT_UNIT_FACTOR > MAX_INT) return { done: false, reason: "too_large", plan: before };

    const f = CREDIT_UNIT_FACTOR;
    await tx.execute(sql`update ${scans} set credits = credits * ${f} where credits <> 0`);
    await tx.execute(sql`update ${scans} set credits_reserved = credits_reserved * ${f} where credits_reserved <> 0`);
    await tx.execute(sql`update ${creditClaims} set credits = credits * ${f} where credits <> 0`);
    await tx.execute(sql`update ${orgBilling} set credits = credits * ${f} where credits <> 0`);
    await tx.execute(sql`
      update ${orgBilling} set auto_top_up = auto_top_up
        || jsonb_build_object('threshold', (auto_top_up ->> 'threshold')::numeric * ${f}, 'quantity', (auto_top_up ->> 'quantity')::numeric * ${f})
      where jsonb_typeof(auto_top_up) = 'object'`);
    await tx.execute(sql`
      update ${orgs} set settings = jsonb_set(settings, '{autoTopUp,quantity}', to_jsonb((settings -> 'autoTopUp' ->> 'quantity')::numeric * ${f}))
      where jsonb_typeof(settings -> 'autoTopUp' -> 'quantity') = 'number'`);
    await tx.execute(sql`update ${usageCarry} set carry_micro_usd = 0 where carry_micro_usd <> 0`);
    // The carries put back to 0 are kept with the marker, so a revert can restore them.
    await tx
      .insert(creditUnitSwitch)
      .values({ kind: "database", subject: "credits", step: "converted", record: { before, carries: before.carries }, log: [{ step: "converted", at: new Date().toISOString() }] })
      .onConflictDoUpdate({
        target: [creditUnitSwitch.kind, creditUnitSwitch.subject],
        set: { step: "converted", record: { before, carries: before.carries }, log: sql`${creditUnitSwitch.log} || ${JSON.stringify([{ step: "converted", at: new Date().toISOString() }])}::jsonb` },
      });
    return { done: true, plan: before };
  });
}

export type RevertOutcome = { done: true } | { done: false; reason: "not_converted" | "held_credits" | "not_whole" };

/**
 * Undoes `convertCredits`, before the app ever ran in cents: every amount divided by 100 and the carries put back.
 * Refuses if any amount is not a whole number of dollar credits (something was written in cents since).
 */
export async function revertCredits(database: Db): Promise<RevertOutcome> {
  return database.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx.execute(LOCK);
    const mark = await marker(tx);
    if (mark?.step !== "converted") return { done: false, reason: "not_converted" };
    if ((await heldCreditScans(tx)) > 0) return { done: false, reason: "held_credits" };
    const f = CREDIT_UNIT_FACTOR;
    const [odd] = (await tx.execute(sql`
      select (select count(*) from ${scans} where credits % ${f} <> 0 or credits_reserved % ${f} <> 0)
           + (select count(*) from ${creditClaims} where credits % ${f} <> 0)
           + (select count(*) from ${orgBilling} where credits % ${f} <> 0) as n`)) as unknown as Array<{ n: string }>;
    if (Number(odd?.n ?? 0) > 0) return { done: false, reason: "not_whole" };
    await tx.execute(sql`update ${scans} set credits = credits / ${f} where credits <> 0`);
    await tx.execute(sql`update ${scans} set credits_reserved = credits_reserved / ${f} where credits_reserved <> 0`);
    await tx.execute(sql`update ${creditClaims} set credits = credits / ${f} where credits <> 0`);
    await tx.execute(sql`update ${orgBilling} set credits = credits / ${f} where credits <> 0`);
    await tx.execute(sql`
      update ${orgBilling} set auto_top_up = auto_top_up
        || jsonb_build_object('threshold', trim_scale((auto_top_up ->> 'threshold')::numeric / ${f}), 'quantity', trim_scale((auto_top_up ->> 'quantity')::numeric / ${f}))
      where jsonb_typeof(auto_top_up) = 'object'`);
    await tx.execute(sql`
      update ${orgs} set settings = jsonb_set(settings, '{autoTopUp,quantity}', to_jsonb(trim_scale((settings -> 'autoTopUp' ->> 'quantity')::numeric / ${f})))
      where jsonb_typeof(settings -> 'autoTopUp' -> 'quantity') = 'number'`);
    const carries = ((mark.record as { carries?: Array<{ orgId: string; microUsd: number }> }).carries ?? []).filter((c) => c.microUsd > 0);
    for (const carry of carries) await tx.update(usageCarry).set({ carryMicroUsd: carry.microUsd }).where(eq(usageCarry.orgId, carry.orgId));
    await tx
      .update(creditUnitSwitch)
      .set({ step: "reverted", log: sql`${creditUnitSwitch.log} || ${JSON.stringify([{ step: "reverted", at: new Date().toISOString() }])}::jsonb` })
      .where(and(eq(creditUnitSwitch.kind, "database"), eq(creditUnitSwitch.subject, "credits")));
    return { done: true };
  });
}
