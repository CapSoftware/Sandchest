import { describe, expect, test } from "bun:test";
import { billLines, chargeMicroUsd, microUsdToUsd, settleCredits, usdToMicroUsd, type UsageLedgerRow } from "../src";

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
