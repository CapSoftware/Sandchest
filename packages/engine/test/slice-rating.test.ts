import { describe, expect, test } from "bun:test";
import { ATTACKERS, type Severity } from "../src/scan";
import { attackerOf, GAINS, RATED_ATTACKER, RATED_ATTACKERS, RatingSchema, severityOf, type Gain } from "../src/scan/slice";

/** The scale as a table: per gain, the severity for anyone, any user, a limited role, a full admin. */
const TABLE: Record<Gain, [Severity, Severity, Severity, Severity]> = {
  code_execution: ["critical", "critical", "critical", "high"],
  account_takeover: ["critical", "critical", "critical", "medium"],
  whole_data_store: ["critical", "critical", "critical", "medium"],
  money: ["critical", "high", "high", "medium"],
  privilege_escalation: ["critical", "high", "high", "medium"],
  change_others_data: ["critical", "high", "high", "medium"],
  read_others_data: ["high", "high", "high", "medium"],
  amplification: ["high", "high", "high", "medium"],
  outage: ["medium", "medium", "medium", "low"],
  limited: ["medium", "medium", "medium", "low"],
  hardening: ["low", "low", "low", "low"],
};
const LEVELS: Severity[] = ["critical", "high", "medium", "low"];

describe("severityOf", () => {
  test("every row of the scale, for every attacker", () => {
    expect([...GAINS]).toEqual(Object.keys(TABLE) as Gain[]);
    expect([...RATED_ATTACKERS]).toEqual(["anyone", "any_user", "limited_role", "full_admin"]);
    for (const gain of GAINS) {
      expect(RATED_ATTACKERS.map((attacker) => severityOf({ attacker, gain, victimMustAct: false, unusualSetup: false }))).toEqual(TABLE[gain]);
    }
  });

  test("a victim who must act and an unusual setup each take it one level down, together two", () => {
    for (const gain of GAINS) {
      for (const attacker of RATED_ATTACKERS) {
        const base = LEVELS.indexOf(severityOf({ attacker, gain, victimMustAct: false, unusualSetup: false }));
        const down = (n: number) => LEVELS[Math.min(3, base + n)];
        expect(severityOf({ attacker, gain, victimMustAct: true, unusualSetup: false })).toBe(down(1)!);
        expect(severityOf({ attacker, gain, victimMustAct: false, unusualSetup: true })).toBe(down(1)!);
        expect(severityOf({ attacker, gain, victimMustAct: true, unusualSetup: true })).toBe(down(2)!);
      }
    }
    expect(severityOf({ attacker: "anyone", gain: "code_execution", victimMustAct: true, unusualSetup: true })).toBe("medium");
    expect(severityOf({ attacker: "anyone", gain: "read_others_data", victimMustAct: true, unusualSetup: false })).toBe("medium");
  });

  test("nothing goes below low", () => {
    expect(severityOf({ attacker: "full_admin", gain: "outage", victimMustAct: true, unusualSetup: true })).toBe("low");
    expect(severityOf({ attacker: "anyone", gain: "hardening", victimMustAct: true, unusualSetup: true })).toBe("low");
    expect(severityOf({ attacker: "any_user", gain: "limited", victimMustAct: true, unusualSetup: true })).toBe("low");
  });
});

describe("the attacker fact", () => {
  test("each attacker class the write-up derives maps onto the scale", () => {
    expect(RATED_ATTACKER).toEqual({ unauthenticated: "anyone", any_user: "any_user", insider: "limited_role", admin: "full_admin" });
    expect(Object.keys(RATED_ATTACKER).sort()).toEqual([...ATTACKERS].sort());
    expect(RATED_ATTACKER[attackerOf("anonymous")!]).toBe("anyone");
    expect(RATED_ATTACKER[attackerOf("any signed-in user")!]).toBe("any_user");
    expect(RATED_ATTACKER[attackerOf("a delegated admin without billing rights")!]).toBe("limited_role");
    expect(RATED_ATTACKER[attackerOf("full admin")!]).toBe("full_admin");
  });

  test("the model is asked for the other three facts only, strictly", () => {
    expect(Object.keys(RatingSchema.shape).sort()).toEqual(["gain", "unusualSetup", "victimMustAct"]);
    expect(RatingSchema.safeParse({ gain: "money", victimMustAct: false, unusualSetup: true }).success).toBe(true);
    expect(RatingSchema.safeParse({ gain: "severe", victimMustAct: false, unusualSetup: true }).success).toBe(false);
    expect(RatingSchema.safeParse({ gain: "money", victimMustAct: "no", unusualSetup: true }).success).toBe(false);
  });
});
