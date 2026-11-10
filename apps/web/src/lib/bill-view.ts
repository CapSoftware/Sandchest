/**
 * A usage bill as a customer sees it: what the scan used, grouped by what it was doing, in credits. Pure, so
 * the scan page, its loading state and the agent API show the same thing. Never the cost, the multiplier, or
 * any amount of money: only counts and credits.
 */
import type { ScanBill } from "@sandchest/db";

/** The bills a customer sees. A voided bill was withdrawn and a shadow bill was never charged: neither is shown. */
const SHOWN = new Set(["open", "charged", "waived"]);

/** The groups a bill's lines fall under, in the order they are shown. */
const GROUPS = ["Hunting", "Scoring", "Verifying in a sandbox", "Looking for variants", "Writing up", "Sandbox time", "Other analysis"] as const;
export type BillGroupLabel = (typeof GROUPS)[number];

const STAGE_GROUP: Record<string, BillGroupLabel> = {
  slice_hunt: "Hunting",
  slice_score: "Scoring",
  rate: "Scoring",
  verify: "Verifying in a sandbox",
  // The second verification session of a deep scan: the same work, shown on the same line.
  verify2: "Verifying in a sandbox",
  variants: "Looking for variants",
  structure: "Writing up",
  consolidate: "Writing up",
  sandbox: "Sandbox time",
};

/** One group of a bill. `credits` and every amount below are in hundredths of a credit. */
export type BillGroup =
  | { kind: "model"; label: BillGroupLabel; calls: number; inputTokens: number; outputTokens: number; credits: number }
  | { kind: "sandbox"; label: BillGroupLabel; seconds: number; credits: number };

export interface BillView {
  status: "open" | "charged" | "waived";
  groups: BillGroup[];
  /** What the lines add up to, in hundredths of a credit: exactly the sum of the groups' credits. */
  usage: number;
  /** Carried from earlier scans, in hundredths. */
  carriedIn: number;
  /** Whole credits charged (or to be charged, while the bill is open). */
  charged: number;
  /** Carried to the next scan, in hundredths. */
  carriedOut: number;
  /** Held to the credits held for the scan. */
  capped: boolean;
  fast: boolean;
  /** Credits held before the scan ran: the most it could be charged. */
  held: number;
  /** What to say under the bill, if anything. A capped bill says so from `capped` and `held`. */
  note: string | null;
}

export type BillSource = Pick<ScanBill, "status" | "fast" | "creditMicroUsd" | "reservedCredits" | "credits" | "carryInMicroUsd" | "carryOutMicroUsd" | "capped" | "lines">;

/** The bill as shown, or undefined for a bill no customer sees (voided, shadow). */
export function billView(bill: BillSource): BillView | undefined {
  if (!SHOWN.has(bill.status)) return undefined;
  const credit = BigInt(bill.creditMicroUsd);
  if (credit <= 0n) return undefined;

  const sums = new Map<BillGroupLabel, { calls: number; inputTokens: number; outputTokens: number; seconds: number; charge: bigint }>();
  for (const line of bill.lines) {
    const label = line.kind === "sandbox" ? "Sandbox time" : (STAGE_GROUP[line.stage] ?? "Other analysis");
    const sum = sums.get(label) ?? { calls: 0, inputTokens: 0, outputTokens: 0, seconds: 0, charge: 0n };
    sum.calls += line.requests;
    sum.inputTokens += line.inputTokens;
    sum.outputTokens += line.outputTokens;
    sum.seconds += line.seconds;
    sum.charge += BigInt(line.chargeMicroUsd);
    sums.set(label, sum);
  }
  const ordered = GROUPS.filter((label) => sums.has(label)).map((label) => ({ label, ...sums.get(label)! }));

  const due = ordered.reduce((total, group) => total + group.charge, 0n);
  const usage = hundredths(due, credit);
  const shares = largestRemainder(
    ordered.map((group) => group.charge),
    credit,
    usage,
  );
  const groups = ordered.map((group, i): BillGroup =>
    group.label === "Sandbox time"
      ? { kind: "sandbox", label: group.label, seconds: Math.round(group.seconds * 1000) / 1000, credits: shares[i]! }
      : { kind: "model", label: group.label, calls: group.calls, inputTokens: group.inputTokens, outputTokens: group.outputTokens, credits: shares[i]! },
  );

  const carryIn = BigInt(bill.carryInMicroUsd);
  const carryOut = BigInt(bill.carryOutMicroUsd);
  // An uncapped bill settles `usage + carried in = charged + carried out` exactly. Rounded one by one, the four could
  // be a hundredth apart, so the carry in is shown as what makes the bill add up as shown.
  const settles = bill.status !== "waived" && !bill.capped;
  const carriedOut = hundredths(carryOut, credit);
  const carriedIn = settles ? Math.max(0, bill.credits * 100 + carriedOut - usage) : hundredths(carryIn, credit);

  return {
    status: bill.status as BillView["status"],
    groups,
    usage,
    carriedIn,
    charged: bill.credits,
    carriedOut,
    capped: bill.capped,
    fast: bill.fast,
    held: bill.reservedCredits,
    note: bill.status === "waived" ? "Not charged: this scan’s usage could not be measured exactly." : null,
  };
}

/** An amount in micro-dollars as hundredths of a credit, rounded half up. */
function hundredths(microUsd: bigint, credit: bigint): number {
  return Number((microUsd * 100n + credit / 2n) / credit);
}

/**
 * Each amount in hundredths of a credit, rounded so they add up to exactly `total`: every amount rounded down,
 * then the hundredths still missing given one each to the amounts that lost the most, earlier ones first on a tie.
 */
export function largestRemainder(amounts: readonly bigint[], credit: bigint, total: number): number[] {
  const floors = amounts.map((amount) => (amount * 100n) / credit);
  const rests = amounts.map((amount, i) => amount * 100n - floors[i]! * credit);
  let missing = total - floors.reduce((sum, floor) => sum + Number(floor), 0);
  const result = floors.map(Number);
  const order = rests.map((rest, i) => ({ rest, i })).sort((a, b) => (a.rest === b.rest ? a.i - b.i : a.rest > b.rest ? -1 : 1));
  for (const { i } of order) {
    if (missing <= 0) break;
    result[i]! += 1;
    missing -= 1;
  }
  return result;
}
