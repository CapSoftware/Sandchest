/** The slice engine's settings: off unless chosen, and then only with everything it needs. */
import { describe, expect, test } from "bun:test";
import { config, scanEngine, sliceBody } from "@/server/config";

const base = {
  DATABASE_URL: "postgres://sandchest@postgres/sandchest",
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY: "key",
  GITHUB_WEBHOOK_SECRET: "secret",
  SANDCHEST_APP_URL: "https://sandchest.example.com",
};
const boat = { SANDCHEST_WORKSPACE: "boat", SANDCHEST_BOAT_API_KEY: "boat_test", SANDCHEST_INDEXER_LINUX_BIN: "/opt/sandchest-index" };
const slice = { ...base, ...boat, SANDCHEST_ENGINE: "slice", SANDCHEST_GATEWAY_SECRET: "gateway-secret-0123456789abcdef-xyz", SANDCHEST_SLICE_CEILING_USD: "0.5", SANDCHEST_SLICE_CEILING_PR_USD: "0.25" };

describe("slice engine settings", () => {
  test("unset, every scan is classic and nothing new is required", () => {
    const settings = config(base);
    expect(settings.SANDCHEST_ENGINE).toBeUndefined();
    for (const kind of ["deep", "pr_review", "recon", "fix_check"]) expect(scanEngine(kind, "acme", settings)).toBe("classic");
    // Blank values, as env files pass them, mean unset.
    expect(scanEngine("deep", "acme", config({ ...base, SANDCHEST_ENGINE: "", SANDCHEST_ENGINE_ORGS: " ", SANDCHEST_SLICE_CEILING_USD: "" }))).toBe("classic");
    expect(scanEngine("deep", "acme", config({ ...base, SANDCHEST_ENGINE: "classic" }))).toBe("classic");
    // A ceiling alone turns nothing on.
    expect(scanEngine("pr_review", "acme", config({ ...base, SANDCHEST_SLICE_CEILING_PR_USD: "0.25", SANDCHEST_SLICE_CEILING_USD: "" }))).toBe("classic");
  });

  test("slice runs deep scans and PR reviews only", () => {
    const settings = config(slice);
    expect(scanEngine("deep", "acme", settings)).toBe("slice");
    expect(scanEngine("pr_review", "acme", settings)).toBe("slice");
    for (const kind of ["recon", "fix_check"]) expect(scanEngine(kind, "acme", settings)).toBe("classic");
    // The account list applies to PR reviews as it does to deep scans.
    const listed = config({ ...slice, SANDCHEST_ENGINE_ORGS: "example-org" });
    expect(scanEngine("pr_review", "acme", listed)).toBe("classic");
    expect(scanEngine("pr_review", "Example-Org", listed)).toBe("slice");
  });

  test("SANDCHEST_ENGINE_ORGS limits it to the accounts it names, in any case", () => {
    const settings = config({ ...slice, SANDCHEST_ENGINE_ORGS: " Acme , example-org," });
    expect(scanEngine("deep", "acme", settings)).toBe("slice");
    expect(scanEngine("deep", "ACME", settings)).toBe("slice");
    expect(scanEngine("deep", "Example-Org", settings)).toBe("slice");
    expect(scanEngine("deep", "other", settings)).toBe("classic");
    expect(scanEngine("deep", "acm", settings)).toBe("classic");
    // Set but naming nobody: nobody.
    expect(scanEngine("deep", "acme", config({ ...slice, SANDCHEST_ENGINE_ORGS: "," }))).toBe("classic");
  });

  test("slice needs boat, the gateway secret and both ceilings, all named in one error", () => {
    const { SANDCHEST_GATEWAY_SECRET: _secret, SANDCHEST_SLICE_CEILING_USD: _ceiling, SANDCHEST_SLICE_CEILING_PR_USD: _pr, ...missing } = slice;
    let message = "";
    try {
      config({ ...missing, SANDCHEST_WORKSPACE: "local" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toStartWith("Invalid server configuration:");
    for (const name of ["SANDCHEST_WORKSPACE", "SANDCHEST_GATEWAY_SECRET", "SANDCHEST_SLICE_CEILING_USD", "SANDCHEST_SLICE_CEILING_PR_USD"]) expect(message).toContain(name);
    // The PR ceiling alone missing is named alone.
    const { SANDCHEST_SLICE_CEILING_PR_USD: _alone, ...noPr } = slice;
    expect(() => config(noPr)).toThrow("SANDCHEST_SLICE_CEILING_PR_USD: is required by the slice engine");
    expect(() => config({ ...noPr, SANDCHEST_SLICE_CEILING_PR_USD: " " })).toThrow("SANDCHEST_SLICE_CEILING_PR_USD");
    expect(() => config({ ...slice, SANDCHEST_WORKSPACE: "sandbox" })).toThrow("SANDCHEST_WORKSPACE: the slice engine needs boat");
  });

  test("each ceiling is a positive decimal", () => {
    expect(config({ ...slice, SANDCHEST_SLICE_CEILING_USD: "1.25" }).SANDCHEST_SLICE_CEILING_USD).toBe("1.25");
    expect(config({ ...slice, SANDCHEST_SLICE_CEILING_PR_USD: "0.125" }).SANDCHEST_SLICE_CEILING_PR_USD).toBe("0.125");
    for (const name of ["SANDCHEST_SLICE_CEILING_USD", "SANDCHEST_SLICE_CEILING_PR_USD"]) {
      for (const bad of ["0", "0.0", "-1", "1e3", "abc", "1.1234567"]) expect(() => config({ ...slice, [name]: bad })).toThrow(name);
    }
    expect(() => config({ ...slice, SANDCHEST_ENGINE: "fast" })).toThrow("SANDCHEST_ENGINE");
  });

  test("LLM_SLICE_BODY is a JSON object when set", () => {
    expect(sliceBody(undefined)).toEqual({ body: {} });
    expect(sliceBody('{"usage":{"include":true}}')).toEqual({ body: { usage: { include: true } } });
    expect(sliceBody("[1]")).toEqual({ problem: "must be a JSON object" });
    expect(sliceBody("{nope")).toEqual({ problem: "must be a JSON object" });
    expect(config({ ...slice, LLM_SLICE_BODY: '{"a":1}' }).LLM_SLICE_BODY).toBe('{"a":1}');
    expect(() => config({ ...slice, LLM_SLICE_BODY: "null" })).toThrow("LLM_SLICE_BODY: must be a JSON object");
  });
});
