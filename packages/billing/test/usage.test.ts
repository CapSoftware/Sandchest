import { describe, expect, test } from "bun:test";
import {
  billLines,
  chargeMicroUsd,
  creditsCovering,
  ledgerTrust,
  microUsdToUsd,
  parseMultiplier,
  selectBillable,
  settleCredits,
  usageBill,
  usdToMicroUsd,
  type BillableUsageRow,
  type UsageBillInput,
  type UsageLedgerRow,
  type UsageRowStatus,
} from "../src";

const model = (stage: string, costUsd: string | number, tokens: Partial<UsageLedgerRow> = {}): UsageLedgerRow => ({
  kind: "model",
  stage,
  inputTokens: 100,
  cachedTokens: 40,
  outputTokens: 20,
  reasoningTokens: 5,
  costUsd,
  ...tokens,
});

/** A small seeded generator, so a failing sequence can be replayed. */
function random(seed: number) {
  let state = seed >>> 0;
  return (below: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % below;
  };
}

describe("usdToMicroUsd", () => {
  test("reads ledger decimals exactly, rounding half up at the micro-dollar", () => {
    expect(usdToMicroUsd("0.0000000000")).toBe(0);
    expect(usdToMicroUsd("1.2345670000")).toBe(1_234_567);
    expect(usdToMicroUsd("0.0000004999")).toBe(0);
    expect(usdToMicroUsd("0.0000005000")).toBe(1);
    expect(usdToMicroUsd("12")).toBe(12_000_000);
    expect(usdToMicroUsd(".5")).toBe(500_000);
    expect(usdToMicroUsd("1e-6")).toBe(1);
  });

  test("numbers go through their decimal form, not float multiplication", () => {
    // 0.07 * 1e6 is 70000.00000000001 in floating point; 1.005 * 1e6 is 1004999.9999999999.
    expect(usdToMicroUsd(0.07)).toBe(70_000);
    expect(usdToMicroUsd(1.005)).toBe(1_005_000);
    expect(usdToMicroUsd(0.1 + 0.2)).toBe(300_000);
    expect(usdToMicroUsd(1e-7)).toBe(0);
    expect(usdToMicroUsd(5e-7)).toBe(1);
  });

  test("refuses what is not a non-negative amount", () => {
    for (const bad of ["-1", "abc", "", ".", "1.2.3", Number.NaN, -0.5, Number.POSITIVE_INFINITY]) {
      expect(() => usdToMicroUsd(bad as string | number)).toThrow(RangeError);
    }
  });

  test("micro-dollars back to a USD string", () => {
    expect([0, 1, 1_250_000, 70_000].map(microUsdToUsd)).toEqual(["0.000000", "0.000001", "1.250000", "0.070000"]);
  });
});

describe("billLines", () => {
  test("one line per kind and stage, with counts, tokens, seconds and cost", () => {
    const lines = billLines([
      model("hunt", "0.0000012000"),
      model("recon", "0.0100000000"),
      model("hunt", "0.0000003000"),
      { kind: "sandbox", stage: "sandbox", inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0, seconds: "61.250", costUsd: "0.0123456789" },
    ]);
    expect(lines).toEqual([
      { kind: "model", stage: "hunt", requests: 2, inputTokens: 200, cachedTokens: 80, outputTokens: 40, reasoningTokens: 10, seconds: 0, costMicroUsd: 2 },
      { kind: "model", stage: "recon", requests: 1, inputTokens: 100, cachedTokens: 40, outputTokens: 20, reasoningTokens: 5, seconds: 0, costMicroUsd: 10_000 },
      { kind: "sandbox", stage: "sandbox", requests: 1, inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0, seconds: 61.25, costMicroUsd: 12_346 },
    ]);
  });

  test("a line rounds once, from the exact sum, so tiny calls are not lost", () => {
    // Each call is 0.4 micro-dollars: rounded alone each would be 0, together they are 4.
    const rows = Array.from({ length: 10 }, () => model("review", "0.0000004000"));
    expect(billLines(rows)[0]!.costMicroUsd).toBe(4);
  });

  test("no rows, no lines", () => {
    expect(billLines([])).toEqual([]);
  });
});

describe("chargeMicroUsd", () => {
  test("multiplies exactly in thousandths and rounds half up", () => {
    expect(chargeMicroUsd(1_000_000, 1000)).toBe(1_000_000);
    expect(chargeMicroUsd(1_000_000, 1234)).toBe(1_234_000);
    expect(chargeMicroUsd(3, 1500)).toBe(5); // 4.5 rounds up
    expect(chargeMicroUsd(1, 1499)).toBe(1); // 1.499 rounds down
    expect(chargeMicroUsd(1, 500)).toBe(1); // 0.5 rounds up
    expect(chargeMicroUsd(1, 499)).toBe(0);
    expect(chargeMicroUsd(0, 7777)).toBe(0);
    expect(chargeMicroUsd(999, 0)).toBe(0);
  });

  test("refuses fractions and negatives", () => {
    expect(() => chargeMicroUsd(1.5, 1000)).toThrow(RangeError);
    expect(() => chargeMicroUsd(-1, 1000)).toThrow(RangeError);
    expect(() => chargeMicroUsd(1, 1000.5)).toThrow(RangeError);
  });
});

describe("settleCredits", () => {
  test("charges whole credits and carries the rest", () => {
    expect(settleCredits(2_500_000, 0, 1_000_000)).toEqual({ credits: 2, carryMicroUsd: 500_000 });
    expect(settleCredits(600_000, 500_000, 1_000_000)).toEqual({ credits: 1, carryMicroUsd: 100_000 });
    expect(settleCredits(0, 999_999, 1_000_000)).toEqual({ credits: 0, carryMicroUsd: 999_999 });
    expect(settleCredits(1, 999_999, 1_000_000)).toEqual({ credits: 1, carryMicroUsd: 0 });
  });

  test("refuses a credit worth nothing, and negative or fractional amounts", () => {
    expect(() => settleCredits(1, 0, 0)).toThrow(RangeError);
    expect(() => settleCredits(-1, 0, 10)).toThrow(RangeError);
    expect(() => settleCredits(1, -1, 10)).toThrow(RangeError);
    expect(() => settleCredits(0.5, 0, 10)).toThrow(RangeError);
  });

  test("over many random sequences, credits × size + final carry is exactly what was due, and nothing goes negative", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const next = random(seed);
      const size = 1 + next(5_000_000);
      const multiplier = next(5000);
      let carry = 0;
      let credits = 0;
      let due = 0n;
      const steps = 1 + next(60);
      for (let i = 0; i < steps; i++) {
        // Costs from a ledger: decimal strings with 10 places, summed into lines, charged, settled.
        const rows = Array.from({ length: 1 + next(8) }, () => model(["hunt", "review", "recon"][next(3)]!, `${next(3)}.${String(next(10_000_000_000)).padStart(10, "0")}`));
        const cost = billLines(rows).reduce((sum, line) => sum + line.costMicroUsd, 0);
        const charge = chargeMicroUsd(cost, multiplier);
        due += BigInt(charge);
        const settled = settleCredits(charge, carry, size);
        expect(settled.credits).toBeGreaterThanOrEqual(0);
        expect(settled.carryMicroUsd).toBeGreaterThanOrEqual(0);
        expect(settled.carryMicroUsd).toBeLessThan(size);
        expect(BigInt(settled.credits) * BigInt(size) + BigInt(settled.carryMicroUsd)).toBe(BigInt(charge) + BigInt(carry));
        credits += settled.credits;
        carry = settled.carryMicroUsd;
      }
      expect(BigInt(credits) * BigInt(size) + BigInt(carry)).toBe(due);
    }
  });
});

// ---- Usage bills ---------------------------------------------------------------

const row = (step: string, attempt: number, status: UsageRowStatus, costUsd: string | number, stage = "hunt", kind = "model"): BillableUsageRow => ({
  ...model(stage, costUsd),
  kind,
  step,
  attempt,
  status,
});

const STATUSES: UsageRowStatus[] = ["started", "ok", "failed", "aborted", "unpriced"];

/** Ledger rows over a few steps, attempts, statuses, kinds and stages; some cost nothing. */
function ledger(next: (below: number) => number): BillableUsageRow[] {
  return Array.from({ length: next(40) }, () => {
    const cost = next(4) === 0 ? "0.0000000000" : `${next(2)}.${String(next(10_000_000_000)).padStart(10, "0")}`;
    const sandbox = next(5) === 0;
    const stage = sandbox ? "sandbox" : ["hunt", "review", "recon"][next(3)]!;
    return row(["recon", "hunt-1", "hunt-2", "verify"][next(4)]!, next(3), STATUSES[next(5)]!, cost, stage, sandbox ? "sandbox" : "model");
  });
}

function shuffled<T>(items: readonly T[], next: (below: number) => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = next(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe("selectBillable", () => {
  test("per step, only the highest attempt; of it, ok rows and aborted rows that cost something; order kept", () => {
    const rows = [
      row("hunt", 0, "ok", "0.1000000000"), // superseded by attempt 1
      row("recon", 0, "ok", "0.2000000000"),
      row("hunt", 1, "ok", "0.3000000000"),
      row("hunt", 1, "failed", "0.0000000000"),
      row("hunt", 1, "aborted", "0.0400000000"),
      row("hunt", 1, "aborted", "0.0000000000"),
      row("hunt", 1, "started", "0.0000000000"),
      row("hunt", 1, "unpriced", "0.0000000000"),
      row("recon", 0, "ok", "0.0000000000"), // ok at no cost still counts, as a request
      row("verify", 2, "failed", "0.0000000000"), // the latest run only failed: nothing of the step counts
      row("verify", 1, "ok", "0.5000000000"),
      row("hunt", 0, "ok", "0.6000000000"),
    ];
    expect(selectBillable(rows)).toEqual([1, 2, 4, 8].map((i) => rows[i]!));
  });

  test("the highest attempt counts wherever it appears, even before the earlier ones", () => {
    const rows = [row("hunt", 2, "ok", "1"), row("hunt", 0, "ok", "1"), row("hunt", 1, "ok", "1")];
    expect(selectBillable(rows)).toEqual([rows[0]!]);
  });

  test("an aborted row that costs the smallest amount the ledger stores counts", () => {
    const rows = [row("hunt", 0, "aborted", "0.0000000001"), row("hunt", 0, "aborted", 0), row("hunt", 0, "aborted", 0.0000001)];
    expect(selectBillable(rows)).toEqual([rows[0]!, rows[2]!]);
  });

  test("no rows, nothing; refuses a negative or fractional attempt", () => {
    expect(selectBillable([])).toEqual([]);
    expect(() => selectBillable([row("hunt", -1, "ok", "1")])).toThrow(RangeError);
    expect(() => selectBillable([row("hunt", 0.5, "ok", "1")])).toThrow(RangeError);
  });
});

describe("ledgerTrust", () => {
  const clean = { unwrittenRows: 0, sandboxExpected: true, sandboxRecorded: true };

  test("trusted when every row finished with a cost, nothing was lost and the sandbox is recorded", () => {
    expect(ledgerTrust([row("hunt", 0, "ok", "1"), row("hunt", 0, "failed", "0"), row("hunt", 0, "aborted", "0")], clean)).toEqual({ trusted: true });
    expect(ledgerTrust([], { unwrittenRows: 0, sandboxExpected: false, sandboxRecorded: false })).toEqual({ trusted: true });
    // A sandbox recorded that was not expected is harmless.
    expect(ledgerTrust([], { unwrittenRows: 0, sandboxExpected: false, sandboxRecorded: true })).toEqual({ trusted: true });
  });

  test("each reason alone", () => {
    expect(ledgerTrust([row("hunt", 0, "unpriced", "0")], clean)).toEqual({ trusted: false, reason: "unpriced" });
    expect(ledgerTrust([row("hunt", 0, "started", "0")], clean)).toEqual({ trusted: false, reason: "started" });
    expect(ledgerTrust([], { ...clean, unwrittenRows: 1 })).toEqual({ trusted: false, reason: "unwritten" });
    expect(ledgerTrust([], { ...clean, sandboxRecorded: false })).toEqual({ trusted: false, reason: "sandbox_missing" });
  });

  test("rows of every attempt count, not only the billable ones", () => {
    const rows = [row("hunt", 0, "unpriced", "0"), row("hunt", 1, "ok", "1")];
    expect(selectBillable(rows)).toEqual([rows[1]!]);
    expect(ledgerTrust(rows, clean)).toEqual({ trusted: false, reason: "unpriced" });
    expect(ledgerTrust([row("hunt", 0, "started", "0"), row("hunt", 3, "ok", "1")], clean)).toEqual({ trusted: false, reason: "started" });
  });

  test("the first failing reason, in a fixed order", () => {
    const all = { unwrittenRows: 2, sandboxExpected: true, sandboxRecorded: false };
    expect(ledgerTrust([row("a", 0, "started", "0"), row("b", 0, "unpriced", "0")], all)).toEqual({ trusted: false, reason: "unpriced" });
    expect(ledgerTrust([row("a", 0, "started", "0")], all)).toEqual({ trusted: false, reason: "started" });
    expect(ledgerTrust([], all)).toEqual({ trusted: false, reason: "unwritten" });
  });

  test("refuses a negative or fractional count of unwritten rows", () => {
    expect(() => ledgerTrust([], { ...clean, unwrittenRows: -1 })).toThrow(RangeError);
    expect(() => ledgerTrust([], { ...clean, unwrittenRows: 0.5 })).toThrow(RangeError);
  });
});

describe("parseMultiplier", () => {
  test("a decimal from 1 to 100, to three places, in exact thousandths", () => {
    const cases: [string, number][] = [
      ["1", 1000],
      ["1.0", 1000],
      ["1.000", 1000],
      ["1.5", 1500],
      ["1.05", 1050],
      ["1.005", 1005],
      ["2.345", 2345],
      ["7", 7000],
      ["07", 7000],
      ["099.999", 99_999],
      ["100", 100_000],
      ["100.000", 100_000],
      // 1.001 * 1000 is 1000.9999999999999 in floating point; read digit by digit it is exact.
      ["1.001", 1001],
      ["4.35", 4350],
    ];
    for (const [text, thousandths] of cases) expect([text, parseMultiplier(text)]).toEqual([text, thousandths]);
  });

  test("anything else is undefined", () => {
    const bad = ["", " ", "0", "0.999", "0.5", "100.001", "101", "999", "1000", "1.0001", "1.", ".5", " 2", "2 ", "2\n", "+2", "-2", "2e0", "1e1", "2,5", "0x10", "Infinity", "NaN", "abc", "1.5.0", "١", "２"];
    for (const text of bad) expect([text, parseMultiplier(text)]).toEqual([text, undefined]);
    expect(parseMultiplier(undefined as unknown as string)).toBeUndefined();
    expect(parseMultiplier(2 as unknown as string)).toBeUndefined();
  });

  test("every value in range, written out, reads back exactly", () => {
    for (let thousandths = 1000; thousandths <= 100_000; thousandths += 7) {
      const text = `${Math.floor(thousandths / 1000)}.${String(thousandths % 1000).padStart(3, "0")}`;
      expect(parseMultiplier(text)).toBe(thousandths);
    }
  });
});

describe("creditsCovering", () => {
  test("the fewest whole credits worth at least the amount", () => {
    expect(creditsCovering(0, 1_000_000)).toBe(0);
    expect(creditsCovering(1, 1_000_000)).toBe(1);
    expect(creditsCovering(999_999, 1_000_000)).toBe(1);
    expect(creditsCovering(1_000_000, 1_000_000)).toBe(1);
    expect(creditsCovering(1_000_001, 1_000_000)).toBe(2);
    expect(creditsCovering(25_000, 10_000)).toBe(3);
    expect(creditsCovering(7, 1)).toBe(7);
    expect(creditsCovering(Number.MAX_SAFE_INTEGER, 1)).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("over many amounts and sizes, it covers and one fewer would not", () => {
    const next = random(42);
    for (let i = 0; i < 5000; i++) {
      const size = 1 + next(3_000_000);
      const amount = next(4) === 0 ? size * next(20) : next(100_000_000);
      const credits = creditsCovering(amount, size);
      expect(BigInt(credits) * BigInt(size) >= BigInt(amount)).toBe(true);
      if (credits > 0) expect(BigInt(credits - 1) * BigInt(size) < BigInt(amount)).toBe(true);
    }
  });

  test("refuses a credit worth nothing, and negative or fractional amounts", () => {
    expect(() => creditsCovering(1, 0)).toThrow(RangeError);
    expect(() => creditsCovering(-1, 10)).toThrow(RangeError);
    expect(() => creditsCovering(0.5, 10)).toThrow(RangeError);
    expect(() => creditsCovering(1, 2.5)).toThrow(RangeError);
    expect(() => creditsCovering(1, -10)).toThrow(RangeError);
  });
});

describe("usageBill", () => {
  const CREDIT = 10_000;
  const bill = (rows: BillableUsageRow[], extra: Partial<UsageBillInput> = {}) =>
    usageBill({ rows, multiplierThousandths: 2000, creditMicroUsd: CREDIT, carryInMicroUsd: 0, reservedCredits: 1000, ...extra });

  test("lines from the billable rows, each charged, adding up exactly to what is due", () => {
    const result = bill(
      [
        row("hunt", 0, "ok", "0.0123456789"), // superseded
        row("hunt", 1, "ok", "0.0100000000"),
        row("hunt", 1, "aborted", "0.0000014000"),
        row("hunt", 1, "failed", "0.9000000000"),
        row("recon", 0, "ok", "0.0000002500", "recon"),
        { ...row("sandbox", 0, "ok", "0.0200000000", "sandbox", "sandbox"), seconds: "30.500" },
      ],
      { carryInMicroUsd: 3_000 },
    );
    expect(result.lines).toEqual([
      { kind: "model", stage: "hunt", requests: 2, inputTokens: 200, cachedTokens: 80, outputTokens: 40, reasoningTokens: 10, seconds: 0, costMicroUsd: 10_001, chargeMicroUsd: 20_002 },
      { kind: "model", stage: "recon", requests: 1, inputTokens: 100, cachedTokens: 40, outputTokens: 20, reasoningTokens: 5, seconds: 0, costMicroUsd: 0, chargeMicroUsd: 0 },
      { kind: "sandbox", stage: "sandbox", requests: 1, inputTokens: 100, cachedTokens: 40, outputTokens: 20, reasoningTokens: 5, seconds: 30.5, costMicroUsd: 20_000, chargeMicroUsd: 40_000 },
    ]);
    // 60,002 due + 3,000 carried = 6 credits of 10,000, and 3,002 carried on.
    expect(result).toMatchObject({ costMicroUsd: 30_001, dueMicroUsd: 60_002, credits: 6, carryInMicroUsd: 3_000, carryOutMicroUsd: 3_002, capped: false });
  });

  test("each line is charged on its own, so the bill adds up as shown", () => {
    // Two lines of 1 micro-dollar at 1.5: each charges 2 (1.5 rounds up), 4 in all, not round(2 × 1.5) = 3.
    const result = bill([row("a", 0, "ok", "0.0000010000", "hunt"), row("b", 0, "ok", "0.0000010000", "review")], { multiplierThousandths: 1500 });
    expect(result.lines.map((line) => line.chargeMicroUsd)).toEqual([2, 2]);
    expect(result.dueMicroUsd).toBe(4);
  });

  test("no billable rows: nothing due, no credits, the carry unchanged", () => {
    for (const rows of [[], [row("hunt", 0, "failed", "1"), row("hunt", 0, "started", "0"), row("hunt", 0, "aborted", "0")]]) {
      expect(bill(rows, { carryInMicroUsd: 9_999 })).toEqual({ lines: [], costMicroUsd: 0, dueMicroUsd: 0, credits: 0, carryInMicroUsd: 9_999, carryOutMicroUsd: 9_999, capped: false });
    }
  });

  test("exactly the reserved credits is not capped; one more is, and the excess is never carried", () => {
    // 0.02 USD at 2x is 40,000 due: exactly 4 credits.
    const rows = [row("hunt", 0, "ok", "0.0200000000")];
    expect(bill(rows, { reservedCredits: 4 })).toMatchObject({ dueMicroUsd: 40_000, credits: 4, carryOutMicroUsd: 0, capped: false });
    expect(bill(rows, { reservedCredits: 3, carryInMicroUsd: 5_000 })).toMatchObject({ dueMicroUsd: 40_000, credits: 3, carryInMicroUsd: 5_000, carryOutMicroUsd: 5_000, capped: true });
    // 40,000 + 9,999 is still 4 whole credits: not capped at 4.
    expect(bill(rows, { reservedCredits: 4, carryInMicroUsd: 9_999 })).toMatchObject({ credits: 4, carryOutMicroUsd: 9_999, capped: false });
    // Over the reserve only with the carry: 39,998 alone is 3 credits, with 2 carried in it is 4, capped at 3.
    const under = [row("hunt", 0, "ok", "0.0199990000")];
    expect(bill(under, { reservedCredits: 3 })).toMatchObject({ dueMicroUsd: 39_998, credits: 3, carryOutMicroUsd: 9_998, capped: false });
    expect(bill(under, { reservedCredits: 3, carryInMicroUsd: 2 })).toMatchObject({ dueMicroUsd: 39_998, credits: 3, carryOutMicroUsd: 2, capped: true });
    // Nothing reserved: nothing charged, whatever is due.
    expect(bill(rows, { reservedCredits: 0, carryInMicroUsd: 7 })).toMatchObject({ credits: 0, carryOutMicroUsd: 7, capped: true });
  });

  test("a due under one credit is carried, not charged, and is not capped", () => {
    expect(bill([row("hunt", 0, "ok", "0.0000010000")], { reservedCredits: 0 })).toMatchObject({ dueMicroUsd: 2, credits: 0, carryOutMicroUsd: 2, capped: false });
  });

  test("refuses a carry of a credit or more, a credit worth nothing, a multiplier out of range, and bad counts", () => {
    const rows = [row("hunt", 0, "ok", "1")];
    expect(() => bill(rows, { carryInMicroUsd: CREDIT })).toThrow(RangeError);
    expect(() => bill(rows, { carryInMicroUsd: -1 })).toThrow(RangeError);
    expect(() => bill(rows, { creditMicroUsd: 0 })).toThrow(RangeError);
    expect(() => bill(rows, { creditMicroUsd: 1.5 })).toThrow(RangeError);
    for (const multiplierThousandths of [0, 999, 100_001, 1500.5, -2000]) expect(() => bill(rows, { multiplierThousandths })).toThrow(RangeError);
    expect(bill(rows, { multiplierThousandths: 1000 }).dueMicroUsd).toBe(1_000_000);
    expect(bill(rows, { multiplierThousandths: 100_000, reservedCredits: 1_000_000 }).dueMicroUsd).toBe(100_000_000);
    expect(() => bill(rows, { reservedCredits: -1 })).toThrow(RangeError);
    expect(() => bill(rows, { reservedCredits: 2.5 })).toThrow(RangeError);
  });

  test("over many generated ledgers, the invariants hold", () => {
    let cappedSeen = 0;
    let uncappedSeen = 0;
    for (let seed = 1; seed <= 2000; seed++) {
      const next = random(seed);
      const rows = ledger(next);
      const size = [1, 10_000, 1_000_000, 1 + next(3_000_000)][next(4)]!;
      const input: UsageBillInput = {
        rows,
        multiplierThousandths: 1000 + next(99_001),
        creditMicroUsd: size,
        carryInMicroUsd: next(size),
        reservedCredits: next(4) === 0 ? 0 : next(5000),
      };
      const result = usageBill(input);
      const due = BigInt(result.dueMicroUsd);
      const carryIn = BigInt(input.carryInMicroUsd);
      const charged = BigInt(result.credits) * BigInt(size);

      expect(result.carryInMicroUsd).toBe(input.carryInMicroUsd);
      expect(result.credits).toBeLessThanOrEqual(input.reservedCredits);
      expect(result.carryOutMicroUsd).toBeGreaterThanOrEqual(0);
      expect(result.carryOutMicroUsd).toBeLessThan(size);
      if (result.capped) {
        cappedSeen++;
        expect(result.credits).toBe(input.reservedCredits);
        expect(result.carryOutMicroUsd).toBe(input.carryInMicroUsd);
        expect(charged < due + carryIn).toBe(true);
      } else {
        uncappedSeen++;
        expect(charged + BigInt(result.carryOutMicroUsd)).toBe(due + carryIn);
      }
      // The bill adds up as shown.
      expect(result.lines.reduce((sum, line) => sum + line.chargeMicroUsd, 0)).toBe(result.dueMicroUsd);
      expect(result.lines.reduce((sum, line) => sum + line.costMicroUsd, 0)).toBe(result.costMicroUsd);
      for (const line of result.lines) expect(line.chargeMicroUsd).toBe(chargeMicroUsd(line.costMicroUsd, input.multiplierThousandths));
      // The same as the bill of the billable rows alone.
      expect(result).toEqual(usageBill({ ...input, rows: selectBillable(rows) }));

      // Rows that never count, added anywhere, change nothing: earlier attempts of a step, and at its latest attempt
      // failed rows, aborted rows that cost nothing, and started and unpriced rows.
      const highest = new Map<string, number>();
      for (const r of rows) highest.set(r.step, Math.max(highest.get(r.step) ?? 0, r.attempt));
      const noise: BillableUsageRow[] = [];
      for (const [step, attempt] of highest) {
        for (let i = 0; i < attempt; i++) noise.push(row(step, i, STATUSES[next(5)]!, `${1 + next(9)}.0000000000`));
        noise.push(row(step, attempt, "failed", "1.0000000000"), row(step, attempt, "aborted", "0.0000000000"), row(step, attempt, "started", "0"), row(step, attempt, "unpriced", "0"));
      }
      // A step whose only run failed or never finished adds nothing either.
      noise.push(row("never-billed", 0, "failed", "3.0000000000"), row("never-billed", 0, "started", "0"));
      const withNoise = usageBill({ ...input, rows: shuffled([...rows, ...noise], next) });
      expect(withNoise.dueMicroUsd).toBe(result.dueMicroUsd);
      expect(withNoise.credits).toBe(result.credits);
      expect(withNoise.carryOutMicroUsd).toBe(result.carryOutMicroUsd);

      // Order does not matter: the same lines (in whatever order they first appear) and the same totals.
      const reordered = usageBill({ ...input, rows: shuffled(rows, next) });
      const byKey = (lines: readonly { kind: string; stage: string }[]) => [...lines].sort((a, b) => `${a.kind}/${a.stage}`.localeCompare(`${b.kind}/${b.stage}`));
      expect(byKey(reordered.lines)).toEqual(byKey(result.lines));
      expect(byKey(withNoise.lines)).toEqual(byKey(result.lines));
      expect({ ...reordered, lines: [] }).toEqual({ ...result, lines: [] });
    }
    // The generator reaches both sides of the cap.
    expect(cappedSeen).toBeGreaterThan(100);
    expect(uncappedSeen).toBeGreaterThan(100);
  });
});
