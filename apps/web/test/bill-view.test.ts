/** A usage bill as customers see it: grouped, adding up exactly, only credits, and only the bills they should see. */
import { describe, expect, test } from "bun:test";
import { CREDIT_UNIT } from "@sandchest/billing";
import type { ScanBillLine } from "@sandchest/db";
import { billView, largestRemainder, type BillSource } from "@/lib/bill-view";
import { money } from "@/lib/format";
import { sampleBill } from "@/lib/samples";
import { billApiView } from "@/server/agent/views";

/** A made-up credit size (a cent), in micro-dollars. */
const CREDIT = 10_000;

function line(stage: string, chargeMicroUsd: number, extra: Partial<ScanBillLine> = {}): ScanBillLine {
  return { kind: "model", stage, requests: 2, inputTokens: 1_000, cachedTokens: 100, outputTokens: 200, reasoningTokens: 10, seconds: 0, costMicroUsd: Math.floor(chargeMicroUsd / 4), chargeMicroUsd, ...extra };
}

function bill(extra: Partial<BillSource> & { lines: ScanBillLine[] }): BillSource {
  const due = extra.lines.reduce((sum, l) => sum + l.chargeMicroUsd, 0);
  const carryIn = extra.carryInMicroUsd ?? 0;
  const credits = Math.floor((due + carryIn) / CREDIT);
  return {
    status: "charged",
    fast: false,
    creditMicroUsd: CREDIT,
    reservedCredits: 500,
    credits,
    carryInMicroUsd: carryIn,
    carryOutMicroUsd: due + carryIn - credits * CREDIT,
    capped: false,
    ...extra,
  };
}

describe("billView", () => {
  test("groups lines under customer labels, in order, leaving empty groups out", () => {
    const view = billView(
      bill({
        lines: [
          line("structure", 10_000),
          line("sandbox", 5_000, { kind: "sandbox", requests: 1, inputTokens: 0, outputTokens: 0, seconds: 61.25 }),
          line("rate", 3_000),
          line("slice_hunt", 40_000),
          line("consolidate", 2_000),
          line("slice_score", 7_000),
          line("something_new", 1_000),
          line("verify", 20_000),
        ],
      }),
    )!;
    expect(view.groups.map((group) => group.label)).toEqual(["Hunting", "Scoring", "Verifying in a sandbox", "Writing up", "Sandbox time", "Other analysis"]);
    const scoring = view.groups.find((group) => group.label === "Scoring")!;
    // `rate` and `slice_score` together: calls and tokens summed, credits from the charge.
    expect(scoring).toEqual({ kind: "model", label: "Scoring", calls: 4, inputTokens: 2_000, outputTokens: 400, credits: 100 });
    expect(view.groups.find((group) => group.label === "Writing up")!.credits).toBe(120);
    expect(view.groups.find((group) => group.label === "Sandbox time")).toEqual({ kind: "sandbox", label: "Sandbox time", seconds: 61.25, credits: 50 });
    expect(view.groups.find((group) => group.label === "Other analysis")!.credits).toBe(10);
    expect(view.usage).toBe(880);
  });

  test("lines add up exactly to the usage shown, however the charges round", () => {
    // Three thirds of a credit and change: rounded one by one they would show 0.33 + 0.33 + 0.33 = 0.99 of 1.00.
    for (const charges of [
      [3_333, 3_333, 3_334],
      [3_335, 3_335, 3_335],
      [1, 1, 1, 1, 1, 1, 1],
      [4_999, 5_001],
      [123_456, 7_891, 2_345_678, 9, 50],
    ]) {
      const stages = ["slice_hunt", "slice_score", "verify", "variants", "structure", "sandbox", "other"];
      const view = billView(bill({ lines: charges.map((charge, i) => line(stages[i]!, charge)) }))!;
      const total = charges.reduce((sum, charge) => sum + charge, 0);
      expect(view.usage).toBe(Math.round((total * 100) / CREDIT));
      expect(view.groups.reduce((sum, group) => sum + group.credits, 0)).toBe(view.usage);
    }
    expect(largestRemainder([3_333n, 3_333n, 3_334n], 10_000n, 100)).toEqual([33, 33, 34]);
    // A tie goes to the earlier line.
    expect(largestRemainder([5_000n, 5_000n], 10_000n, 100)).toEqual([50, 50]);
    expect(largestRemainder([3_350n, 3_350n, 3_300n], 10_000n, 100)).toEqual([34, 33, 33]);
  });

  test("totals: usage and carry in come to what was charged and carried out", () => {
    const view = billView(bill({ lines: [line("slice_hunt", 427_300)], carryInMicroUsd: 5_000 }))!;
    expect(view).toMatchObject({ status: "charged", usage: 4_273, carriedIn: 50, charged: 43, carriedOut: 23, capped: false, held: 500, note: null, fast: false });
    expect(view.usage + view.carriedIn).toBe(view.charged * 100 + view.carriedOut);
    // Rounded one by one these would be a hundredth apart: the carry in is shown so the bill adds up as shown.
    const odd = billView(bill({ lines: [line("slice_hunt", 4_449)], carryInMicroUsd: 5_549 }))!;
    expect(odd.usage + odd.carriedIn).toBe(odd.charged * 100 + odd.carriedOut);
    // 0.44 of a credit, as its line shows it: to four decimals of a dollar.
    expect(odd.usage).toBe(44);
    expect(money(odd.usage / 100, true)).toBe(CREDIT_UNIT === "cent" ? "$0.0044" : "$0.4400");
  });

  test("a capped bill is marked capped, at the credits held, and charges them", () => {
    const view = billView(bill({ lines: [line("slice_hunt", 900_000)], reservedCredits: 40, credits: 40, carryInMicroUsd: 1_200, carryOutMicroUsd: 1_200, capped: true }))!;
    expect(view).toMatchObject({ usage: 9_000, carriedIn: 12, charged: 40, carriedOut: 12, capped: true, held: 40 });
    // The page says what it was capped at from these: the view itself carries no amount of money.
    expect(view).toMatchObject({ capped: true, held: 40, charged: 40, note: null });
  });

  test("a waived bill charges nothing and says why", () => {
    const view = billView(bill({ status: "waived", lines: [line("slice_hunt", 20_000)], credits: 0, carryInMicroUsd: 300, carryOutMicroUsd: 300 }))!;
    expect(view).toMatchObject({ status: "waived", usage: 200, charged: 0, carriedIn: 3, carriedOut: 3 });
    expect(view.note).toBe("Not charged: this scan’s usage could not be measured exactly.");
  });

  test("an open bill is shown; a voided or shadow bill never is", () => {
    const lines = [line("slice_hunt", 20_000)];
    expect(billView(bill({ status: "open", lines }))!.status).toBe("open");
    expect(billView(bill({ status: "voided", lines }))).toBeUndefined();
    expect(billView(bill({ status: "shadow", lines }))).toBeUndefined();
  });

  test("fast comes from the bill", () => {
    expect(billView(bill({ fast: true, lines: [line("slice_hunt", 1)] }))!.fast).toBe(true);
  });

  test("never a cost, the multiplier, micro-dollars or money", () => {
    const stored = { ...bill({ lines: [line("slice_hunt", 123_457), line("sandbox", 9_999, { kind: "sandbox" })], carryInMicroUsd: 4_321 }), costMicroUsd: 31_111, dueMicroUsd: 133_456, multiplierThousandths: 4_000 };
    for (const shown of [billView(stored)!, billApiView(billView(stored)!)]) {
      const text = JSON.stringify(shown);
      expect(text).not.toMatch(/cost|multiplier|micro|usd|\$|dollar/i);
      // No raw micro-dollar amount leaks through.
      for (const amount of ["123457", "9999", "4321", "31111", "133456", "4000"]) expect(text).not.toContain(amount);
    }
  });

  test("the agent API's bill: the same numbers in credits, snake_case", () => {
    const view = billView(bill({ lines: [line("slice_hunt", 427_300), line("sandbox", 2_000, { kind: "sandbox", requests: 1, seconds: 12.5 })], carryInMicroUsd: 5_000, fast: true }))!;
    expect(billApiView(view)).toEqual({
      status: "charged",
      lines: [
        { label: "Hunting", calls: 2, input_tokens: 1_000, output_tokens: 200, credits: 42.73 },
        { label: "Sandbox time", sandbox_seconds: 12.5, credits: 0.2 },
      ],
      usage: 42.93,
      carried_in: 0.5,
      charged: 43,
      carried_out: 0.43,
      capped: false,
      fast: true,
      held: 500,
    });
  });

  test("the loading state's sample adds up", () => {
    const sample = sampleBill();
    expect(sample.groups.reduce((sum, group) => sum + group.credits, 0)).toBe(sample.usage);
    expect(sample.usage + sample.carriedIn).toBe(sample.charged * 100 + sample.carriedOut);
  });
});
