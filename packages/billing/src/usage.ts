/**
 * Usage-based billing arithmetic, in whole micro-dollars (1 USD = 1,000,000)
 * so no amount ever drifts. Pure: nothing here reads a setting or charges
 * anyone. The multiplier is passed in thousandths (1,000 = cost price), so a
 * fractional multiplier is exact.
 */

export const MICRO_USD_PER_USD = 1_000_000;

/** One ledger row, as the database returns it: decimals as exact strings (numbers are accepted too). */
export interface UsageLedgerRow {
  kind: string;
  stage: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  seconds?: string | number | null;
  costUsd: string | number;
}

/** What a bill shows for one kind of spend in one stage. */
export interface BillLine {
  kind: string;
  stage: string;
  /** Ledger rows: model calls, or sandboxes. */
  requests: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** Machine time, summed in whole milliseconds. */
  seconds: number;
  /** Rounded half up once, from the exact sum of the line's rows. */
  costMicroUsd: number;
}

/** Ledger costs carry 10 decimals; sums keep 12 so nothing is lost before the one rounding. */
const EXACT_DECIMALS = 12;
const EXACT_PER_MICRO = 10n ** BigInt(EXACT_DECIMALS - 6);

/** Ledger rows grouped into bill lines per kind and stage, in the order each first appears. */
export function billLines(rows: readonly UsageLedgerRow[]): BillLine[] {
  const lines = new Map<string, { line: BillLine; cost: bigint; millis: bigint }>();
  for (const row of rows) {
    const key = `${row.kind}\u0000${row.stage}`;
    let entry = lines.get(key);
    if (!entry) {
      entry = {
        line: { kind: row.kind, stage: row.stage, requests: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0, seconds: 0, costMicroUsd: 0 },
        cost: 0n,
        millis: 0n,
      };
      lines.set(key, entry);
    }
    entry.line.requests += 1;
    entry.line.inputTokens += wholeCount(row.inputTokens);
    entry.line.cachedTokens += wholeCount(row.cachedTokens);
    entry.line.outputTokens += wholeCount(row.outputTokens);
    entry.line.reasoningTokens += wholeCount(row.reasoningTokens);
    entry.cost += scaled(row.costUsd, EXACT_DECIMALS);
    if (row.seconds !== null && row.seconds !== undefined) entry.millis += scaled(row.seconds, 3);
  }
  return [...lines.values()].map(({ line, cost, millis }) => ({
    ...line,
    seconds: Number(millis) / 1000,
    costMicroUsd: toSafe(roundHalfUp(cost, EXACT_PER_MICRO)),
  }));
}

/** A decimal USD amount (string or number) in micro-dollars, rounded half up. Never negative. */
export function usdToMicroUsd(value: string | number): number {
  return toSafe(scaled(value, 6));
}

/** Micro-dollars as a USD decimal string with all six places, e.g. `1.250000`. */
export function microUsdToUsd(micro: number): string {
  const value = BigInt(nonNegative(micro, "micro-dollars"));
  const fraction = (value % 1_000_000n).toString().padStart(6, "0");
  return `${value / 1_000_000n}.${fraction}`;
}

/** What is due for a cost: `cost × multiplier / 1000`, rounded half up at the micro-dollar. */
export function chargeMicroUsd(costMicroUsd: number, multiplierThousandths: number): number {
  const cost = BigInt(nonNegative(costMicroUsd, "cost"));
  const multiplier = BigInt(nonNegative(multiplierThousandths, "multiplier"));
  return toSafe(roundHalfUp(cost * multiplier, 1000n));
}

export interface CreditSettlement {
  /** Whole credits to charge now. */
  credits: number;
  /** What is left over, under one credit, carried to the next settlement. */
  carryMicroUsd: number;
}

/**
 * Whole credits for an amount due plus what was carried from before; the
 * remainder under one credit is carried on. Always
 * `credits × creditMicroUsd + carryMicroUsd = dueMicroUsd + previous carry`.
 */
export function settleCredits(dueMicroUsd: number, carryMicroUsd: number, creditMicroUsd: number): CreditSettlement {
  const due = nonNegative(dueMicroUsd, "amount due");
  const carry = nonNegative(carryMicroUsd, "carry");
  const size = nonNegative(creditMicroUsd, "credit size");
  if (size === 0) throw new RangeError("A credit must be worth more than nothing");
  const total = BigInt(due) + BigInt(carry);
  const credits = total / BigInt(size);
  return { credits: toSafe(credits), carryMicroUsd: toSafe(total - credits * BigInt(size)) };
}

// ---- Usage bills -------------------------------------------------------------

/** How a ledger row's call ended (the ledger's `status`). */
export type UsageRowStatus = "started" | "ok" | "failed" | "aborted" | "unpriced";

/** A ledger row as a bill reads it: which run of which step wrote it, and how it ended. */
export interface BillableUsageRow extends UsageLedgerRow {
  /** The unit of work that can be run again. */
  step: string;
  /** Which run of its step wrote the row. */
  attempt: number;
  status: UsageRowStatus;
}

/**
 * The rows a bill counts. Per step, only rows of that step's highest attempt (a step run again
 * replaces its earlier runs); of those, `ok` rows and `aborted` rows that cost something. Order kept.
 */
export function selectBillable<Row extends BillableUsageRow>(rows: readonly Row[]): Row[] {
  const latest = new Map<string, number>();
  for (const row of rows) {
    const attempt = nonNegative(row.attempt, "attempt");
    const highest = latest.get(row.step);
    if (highest === undefined || attempt > highest) latest.set(row.step, attempt);
  }
  return rows.filter((row) => {
    if (row.attempt !== latest.get(row.step)) return false;
    if (row.status === "ok") return true;
    return row.status === "aborted" && scaled(row.costUsd, EXACT_DECIMALS) > 0n;
  });
}

/** What the app knows about a scan's ledger beyond its rows. */
export interface LedgerFacts {
  /** Rows the app knows it failed to write. */
  unwrittenRows: number;
  /** A sandbox ran for the scan. */
  sandboxExpected: boolean;
  /** The sandbox's cost row is in the ledger. */
  sandboxRecorded: boolean;
}

export type LedgerDistrust = "unpriced" | "started" | "unwritten" | "sandbox_missing";

/**
 * Whether a scan's ledger can be billed from at all. Call it only once nothing of the scan can still be
 * in flight: a `started` row is then a call whose outcome was never seen, and makes the ledger untrusted.
 * Every attempt counts here, not only the billable ones. The first reason found, in this order: a row
 * `unpriced`, a row `started`, rows known unwritten, a sandbox that ran with no cost row.
 */
export function ledgerTrust(rows: readonly Pick<BillableUsageRow, "status">[], facts: LedgerFacts): { trusted: true } | { trusted: false; reason: LedgerDistrust } {
  const unwritten = nonNegative(facts.unwrittenRows, "count of unwritten rows");
  if (rows.some((row) => row.status === "unpriced")) return { trusted: false, reason: "unpriced" };
  if (rows.some((row) => row.status === "started")) return { trusted: false, reason: "started" };
  if (unwritten > 0) return { trusted: false, reason: "unwritten" };
  if (facts.sandboxExpected && !facts.sandboxRecorded) return { trusted: false, reason: "sandbox_missing" };
  return { trusted: true };
}

export const MIN_MULTIPLIER_THOUSANDTHS = 1_000;
export const MAX_MULTIPLIER_THOUSANDTHS = 100_000;

/**
 * A multiplier written as a decimal (`1` to `100`, at most three decimals) in thousandths, read digit by
 * digit. Undefined for anything else, spaces, signs and exponents included.
 */
export function parseMultiplier(text: string): number | undefined {
  if (typeof text !== "string") return undefined;
  const match = /^(\d{1,3})(?:\.(\d{1,3}))?$/.exec(text);
  if (!match) return undefined;
  const thousandths = Number(match[1]) * 1000 + Number((match[2] ?? "").padEnd(3, "0"));
  if (thousandths < MIN_MULTIPLIER_THOUSANDTHS || thousandths > MAX_MULTIPLIER_THOUSANDTHS) return undefined;
  return thousandths;
}

/** The fewest whole credits worth at least the amount: 0 for 0. */
export function creditsCovering(amountMicroUsd: number, creditMicroUsd: number): number {
  const amount = BigInt(nonNegative(amountMicroUsd, "amount"));
  const size = nonNegative(creditMicroUsd, "credit size");
  if (size === 0) throw new RangeError("A credit must be worth more than nothing");
  return toSafe((amount + BigInt(size) - 1n) / BigInt(size));
}

/** A bill line with what it charges: its cost times the multiplier. */
export interface UsageBillLine extends BillLine {
  chargeMicroUsd: number;
}

export interface UsageBillInput {
  /** Every row of the scan's ledger; the bill picks the billable ones itself. */
  rows: readonly BillableUsageRow[];
  /** 1,000 to 100,000. */
  multiplierThousandths: number;
  /** What one credit is worth. */
  creditMicroUsd: number;
  /** The account's carry before this bill, under one credit. */
  carryInMicroUsd: number;
  /** Credits held for the scan before it ran: the most it can be charged. */
  reservedCredits: number;
}

export interface UsageBill {
  lines: UsageBillLine[];
  /** The lines' costs. */
  costMicroUsd: number;
  /** The lines' charges, so the bill adds up exactly as shown. */
  dueMicroUsd: number;
  /** Whole credits to charge, never more than were reserved. */
  credits: number;
  carryInMicroUsd: number;
  /** The account's carry after this bill, under one credit. */
  carryOutMicroUsd: number;
  /** The charge was held to the reserved credits. What was due beyond them is never charged, now or later. */
  capped: boolean;
}

/**
 * A scan's usage bill. Pure; it does not ask whether the ledger can be trusted (`ledgerTrust`), the caller
 * does. Not capped: `credits × credit + carryOut = due + carryIn`. Capped: the reserved credits are charged
 * and the carry is left as it was, so the excess is ours, never carried into a later bill.
 */
export function usageBill(input: UsageBillInput): UsageBill {
  const multiplier = nonNegative(input.multiplierThousandths, "multiplier");
  if (multiplier < MIN_MULTIPLIER_THOUSANDTHS || multiplier > MAX_MULTIPLIER_THOUSANDTHS) throw new RangeError(`The multiplier must be from 1,000 to 100,000 thousandths: ${multiplier}`);
  const size = nonNegative(input.creditMicroUsd, "credit size");
  if (size === 0) throw new RangeError("A credit must be worth more than nothing");
  const carryIn = nonNegative(input.carryInMicroUsd, "carry");
  if (carryIn >= size) throw new RangeError(`The carry must be under one credit: ${carryIn}`);
  const reserved = nonNegative(input.reservedCredits, "reserved credits");

  const lines = billLines(selectBillable(input.rows)).map((line) => ({ ...line, chargeMicroUsd: chargeMicroUsd(line.costMicroUsd, multiplier) }));
  const costMicroUsd = toSafe(lines.reduce((sum, line) => sum + BigInt(line.costMicroUsd), 0n));
  const dueMicroUsd = toSafe(lines.reduce((sum, line) => sum + BigInt(line.chargeMicroUsd), 0n));
  const settled = settleCredits(dueMicroUsd, carryIn, size);
  if (settled.credits > reserved) {
    return { lines, costMicroUsd, dueMicroUsd, credits: reserved, carryInMicroUsd: carryIn, carryOutMicroUsd: carryIn, capped: true };
  }
  return { lines, costMicroUsd, dueMicroUsd, credits: settled.credits, carryInMicroUsd: carryIn, carryOutMicroUsd: settled.carryMicroUsd, capped: false };
}

/**
 * A non-negative decimal as an integer count of 10^-`decimals` units, rounded half up. Strings are
 * parsed digit by digit; a number goes through its shortest round-trip decimal form, never through
 * float multiplication.
 */
function scaled(value: string | number, decimals: number): bigint {
  const text = typeof value === "number" ? numberText(value) : value.trim();
  const match = /^\+?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match || (match[1] === "" && (match[2] ?? "") === "")) throw new RangeError(`Not a non-negative decimal: ${JSON.stringify(value)}`);
  const digits = `${match[1]}${match[2] ?? ""}`;
  // The decimal point sits this many digits from the left of `digits`, after the exponent.
  const point = match[1]!.length + Number(match[3] ?? 0);
  const keep = point + decimals;
  if (keep <= 0) return keep === 0 && Number(digits[0] ?? "0") >= 5 ? 1n : 0n;
  const whole = BigInt(digits.slice(0, keep).padEnd(keep, "0") || "0");
  return digits.length > keep && Number(digits[keep]) >= 5 ? whole + 1n : whole;
}

function numberText(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`Not a non-negative amount: ${value}`);
  return String(value);
}

function roundHalfUp(value: bigint, divisor: bigint): bigint {
  return (value + divisor / 2n) / divisor;
}

function wholeCount(value: number): number {
  return nonNegative(value, "token count");
}

function nonNegative(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`The ${what} must be a whole number, not negative: ${value}`);
  return value;
}

function toSafe(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Amount too large to represent exactly");
  return Number(value);
}
