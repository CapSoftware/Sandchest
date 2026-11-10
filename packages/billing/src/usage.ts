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
