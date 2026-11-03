import { describe, expect, test } from "bun:test";
import { advance, JOLT_S, joltAt, newSignals } from "@/components/rig/signals";

describe("rig signals", () => {
  test("a find jolts only while it lands, never before it is typed out", () => {
    const s = newSignals();
    s.joltUntil = 10 + JOLT_S;
    expect(joltAt(s, 5)).toBe(0);
    expect(joltAt(s, 10)).toBeCloseTo(JOLT_S);
    expect(joltAt(s, 10 + JOLT_S / 2)).toBeCloseTo(JOLT_S / 2);
    expect(joltAt(s, 10 + JOLT_S)).toBe(0);
    expect(joltAt(null, 1)).toBe(0);
  });

  test("a remounted scene's clock carries the signals back with it", () => {
    const s = newSignals();
    advance(s, 60);
    s.joltUntil = 60.5;
    s.typingUntil = 61;
    // The lower tier's scene starts its clock again from 0.
    advance(s, 0.02);
    expect(s.joltUntil).toBeCloseTo(0.52);
    expect(s.typingUntil).toBeCloseTo(1.02);
    expect(joltAt(s, 0.02)).toBeLessThanOrEqual(JOLT_S);
    advance(s, 0.5);
    expect(s.joltUntil).toBeCloseTo(0.52);
  });
});
