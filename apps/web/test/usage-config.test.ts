/** Usage billing settings: off unless chosen, a multiplier always checked, and on only with what it needs. */
import { describe, expect, test } from "bun:test";
import { config, creditUnit, scanPricingMode, usageMultiplierThousandths } from "@/server/config";

const base = {
  DATABASE_URL: "postgres://sandchest@postgres/sandchest",
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY: "key",
  GITHUB_WEBHOOK_SECRET: "secret",
  SANDCHEST_APP_URL: "https://sandchest.example.com",
};
const boat = { SANDCHEST_WORKSPACE: "boat", SANDCHEST_BOAT_API_KEY: "boat_test", SANDCHEST_INDEXER_LINUX_BIN: "/opt/sandchest-index" } as const;
const slice = { ...base, ...boat, SANDCHEST_ENGINE: "slice", SANDCHEST_GATEWAY_SECRET: "gateway-secret-0123456789abcdef-xyz", SANDCHEST_SLICE_CEILING_USD: "0.5", SANDCHEST_SLICE_CEILING_PR_USD: "0.25" } as const;
/** A made-up multiplier. */
const multiplier = { SANDCHEST_USAGE_MULTIPLIER: "2.5" };

function problems(env: Record<string, string | undefined>): string {
  try {
    config(env);
  } catch (error) {
    return (error as Error).message;
  }
  return "";
}

describe("usage billing settings", () => {
  test("all unset, config is what it was before them", () => {
    expect(config(base)).toEqual({ ...base, workspace: "local" });
    expect(config(slice)).toEqual({ ...slice, workspace: "boat" });
    // Blank values, as env files pass them, mean unset.
    const blank = { SANDCHEST_USAGE_BILLING: "", SANDCHEST_USAGE_MULTIPLIER: " ", NEXT_PUBLIC_SANDCHEST_CREDIT_UNIT: "" };
    expect(config({ ...base, ...blank })).toEqual({ ...base, workspace: "local" });
    expect(config({ ...slice, ...blank })).toEqual({ ...slice, workspace: "boat" });
    expect(usageMultiplierThousandths(config(base))).toBeUndefined();
    expect(creditUnit(config(base))).toBe("dollar");
    expect(scanPricingMode("slice", config(slice))).toBe("tiered");
  });

  test("the multiplier is read exactly, in thousandths", () => {
    expect(usageMultiplierThousandths(config({ ...slice, ...multiplier }))).toBe(2500);
    expect(usageMultiplierThousandths(config({ ...base, SANDCHEST_USAGE_MULTIPLIER: "1.001" }))).toBe(1001);
    expect(usageMultiplierThousandths(config({ ...base, SANDCHEST_USAGE_MULTIPLIER: "100" }))).toBe(100_000);
  });

  test("a multiplier that is set but invalid is an error even with usage billing off, and the error never repeats it", () => {
    for (const bad of ["0.5", "101", "1.0001", "-2", "+2", "2e0", "abc", " 2", "2 ", "1,5"]) {
      for (const env of [base, slice, { ...slice, SANDCHEST_USAGE_BILLING: "off" }]) {
        const message = problems({ ...env, SANDCHEST_USAGE_MULTIPLIER: bad });
        expect(message).toStartWith("Invalid server configuration:");
        expect(message).toContain("SANDCHEST_USAGE_MULTIPLIER: must be a decimal from 1 to 100");
        expect(message.split("SANDCHEST_USAGE_MULTIPLIER:")[1]).not.toContain(bad.trim());
      }
    }
  });

  test("shadow and on need the slice engine and a multiplier; on also needs credits worth a cent; all named in one error", () => {
    const shadow = problems({ ...base, SANDCHEST_USAGE_BILLING: "shadow" });
    expect(shadow).toContain("SANDCHEST_USAGE_MULTIPLIER: is required by usage billing");
    expect(shadow).toContain("SANDCHEST_ENGINE: must be slice for usage billing");
    expect(shadow).not.toContain("NEXT_PUBLIC_SANDCHEST_CREDIT_UNIT");

    const on = problems({ ...base, SANDCHEST_USAGE_BILLING: "on", NEXT_PUBLIC_SANDCHEST_CREDIT_UNIT: "dollar" });
    for (const name of ["SANDCHEST_USAGE_MULTIPLIER", "SANDCHEST_ENGINE", "NEXT_PUBLIC_SANDCHEST_CREDIT_UNIT"]) expect(on).toContain(name);
    // The default unit is a dollar, so on alone with nothing else names the unit too.
    expect(problems({ ...slice, ...multiplier, SANDCHEST_USAGE_BILLING: "on" })).toBe("Invalid server configuration:\n  NEXT_PUBLIC_SANDCHEST_CREDIT_UNIT: must be cent when usage billing is on");
    // Classic named explicitly is not slice.
    expect(problems({ ...base, ...multiplier, SANDCHEST_ENGINE: "classic", SANDCHEST_USAGE_BILLING: "shadow" })).toContain("SANDCHEST_ENGINE: must be slice for usage billing");

    // One error with the slice engine's problems and usage billing's together.
    const { SANDCHEST_GATEWAY_SECRET: _secret, ...noSecret } = slice;
    const both = problems({ ...noSecret, SANDCHEST_USAGE_BILLING: "on", SANDCHEST_USAGE_MULTIPLIER: "0" });
    for (const name of ["SANDCHEST_GATEWAY_SECRET", "SANDCHEST_USAGE_MULTIPLIER", "NEXT_PUBLIC_SANDCHEST_CREDIT_UNIT"]) expect(both).toContain(name);
    expect(both.match(/Invalid server configuration/g)).toHaveLength(1);
  });

  test("valid shadow and on", () => {
    expect(() => config({ ...slice, ...multiplier, SANDCHEST_USAGE_BILLING: "shadow" })).not.toThrow();
    expect(() => config({ ...slice, ...multiplier, SANDCHEST_USAGE_BILLING: "shadow", NEXT_PUBLIC_SANDCHEST_CREDIT_UNIT: "cent" })).not.toThrow();
    const on = config({ ...slice, ...multiplier, SANDCHEST_USAGE_BILLING: "on", NEXT_PUBLIC_SANDCHEST_CREDIT_UNIT: "cent" });
    expect(on).toMatchObject({ SANDCHEST_USAGE_BILLING: "on", NEXT_PUBLIC_SANDCHEST_CREDIT_UNIT: "cent" });
    expect(creditUnit(on)).toBe("cent");
    expect(usageMultiplierThousandths(on)).toBe(2500);
    // Off with a valid multiplier and any unit is fine on either engine.
    expect(() => config({ ...base, ...multiplier, SANDCHEST_USAGE_BILLING: "off", NEXT_PUBLIC_SANDCHEST_CREDIT_UNIT: "cent" })).not.toThrow();
  });

  test("unknown values are errors", () => {
    expect(problems({ ...slice, ...multiplier, SANDCHEST_USAGE_BILLING: "yes" })).toContain("SANDCHEST_USAGE_BILLING");
    expect(problems({ ...base, NEXT_PUBLIC_SANDCHEST_CREDIT_UNIT: "euro" })).toContain("NEXT_PUBLIC_SANDCHEST_CREDIT_UNIT");
  });

  test("classic scans are always tiered; slice scans follow the setting", () => {
    const settings = (billing?: string) =>
      config({ ...slice, ...multiplier, NEXT_PUBLIC_SANDCHEST_CREDIT_UNIT: "cent", ...(billing === undefined ? {} : { SANDCHEST_USAGE_BILLING: billing }) });
    for (const billing of [undefined, "off", "shadow", "on"]) expect(scanPricingMode("classic", settings(billing))).toBe("tiered");
    expect(scanPricingMode("slice", settings(undefined))).toBe("tiered");
    expect(scanPricingMode("slice", settings("off"))).toBe("tiered");
    expect(scanPricingMode("slice", settings("shadow"))).toBe("shadow");
    expect(scanPricingMode("slice", settings("on"))).toBe("usage");
  });
});
