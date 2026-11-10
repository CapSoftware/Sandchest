/** The slice engine's settings: off unless chosen, and then only with everything it needs. */
import { describe, expect, test } from "bun:test";
import { INDEXER_PORT } from "@sandchest/workspace";
import { RELAY_PORT } from "@/server/slice-scan";
import { config, fastModeAvailable, fastRunAllowed, scanEngine, sliceBody, scanWorkspace } from "@/server/config";

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

  test("slice needs a Boat key, the Linux indexer, the gateway secret and both ceilings, all named in one error", () => {
    const { SANDCHEST_GATEWAY_SECRET: _secret, SANDCHEST_SLICE_CEILING_USD: _ceiling, SANDCHEST_SLICE_CEILING_PR_USD: _pr, SANDCHEST_BOAT_API_KEY: _key, SANDCHEST_INDEXER_LINUX_BIN: _bin, ...missing } = slice;
    let message = "";
    try {
      config({ ...missing, SANDCHEST_WORKSPACE: "local" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toStartWith("Invalid server configuration:");
    for (const name of ["SANDCHEST_BOAT_API_KEY", "SANDCHEST_INDEXER_LINUX_BIN", "SANDCHEST_GATEWAY_SECRET", "SANDCHEST_SLICE_CEILING_USD", "SANDCHEST_SLICE_CEILING_PR_USD"]) expect(message).toContain(name);
    // The PR ceiling alone missing is named alone.
    const { SANDCHEST_SLICE_CEILING_PR_USD: _alone, ...noPr } = slice;
    expect(() => config(noPr)).toThrow("SANDCHEST_SLICE_CEILING_PR_USD: is required by the slice engine");
    expect(() => config({ ...noPr, SANDCHEST_SLICE_CEILING_PR_USD: " " })).toThrow("SANDCHEST_SLICE_CEILING_PR_USD");
    // Classic scans keep their own workspace: the slice engine opens Boat sandboxes itself.
    for (const workspace of ["sandbox", "local", "boat"]) expect(config({ ...slice, SANDCHEST_WORKSPACE: workspace })).toMatchObject({ SANDCHEST_ENGINE: "slice", workspace });
    expect(config({ ...slice, SANDCHEST_WORKSPACE: undefined, VERCEL: "1" }).workspace).toBe("sandbox");
  });

  test("an account on the slice engine runs all its work on Boat; every other account stays on the configured workspace", () => {
    // Unset or classic: the configured workspace for everyone, as today.
    for (const workspace of ["sandbox", "local", "boat"] as const) {
      expect(scanWorkspace("acme", config({ ...base, ...boat, SANDCHEST_WORKSPACE: workspace }))).toBe(workspace);
      expect(scanWorkspace("acme", config({ ...base, ...boat, SANDCHEST_WORKSPACE: workspace, SANDCHEST_ENGINE: "classic" }))).toBe(workspace);
    }
    // Slice for a list of accounts: Boat for them only, whatever the kind of work.
    const listed = config({ ...slice, SANDCHEST_WORKSPACE: "sandbox", SANDCHEST_ENGINE_ORGS: "Acme, other" });
    expect(scanWorkspace("acme", listed)).toBe("boat");
    expect(scanWorkspace("OTHER", listed)).toBe("boat");
    expect(scanWorkspace("someone-else", listed)).toBe("sandbox");
    // Slice for everyone: Boat for everyone.
    expect(scanWorkspace("someone-else", config({ ...slice, SANDCHEST_WORKSPACE: "sandbox" }))).toBe("boat");
  });

  test("the slice engine's own indexer build is a URL with its checksum, both or neither", () => {
    const build = { SANDCHEST_SLICE_INDEXER_LINUX_URL: "https://downloads.example.com/sandchest-index", SANDCHEST_SLICE_INDEXER_LINUX_SHA256: "a".repeat(64) };
    expect(config({ ...slice, ...build })).toMatchObject(build);
    expect(() => config({ ...slice, SANDCHEST_SLICE_INDEXER_LINUX_URL: build.SANDCHEST_SLICE_INDEXER_LINUX_URL })).toThrow("set both or neither");
    expect(() => config({ ...slice, SANDCHEST_SLICE_INDEXER_LINUX_SHA256: build.SANDCHEST_SLICE_INDEXER_LINUX_SHA256 })).toThrow("set both or neither");
    expect(() => config({ ...slice, ...build, SANDCHEST_SLICE_INDEXER_LINUX_SHA256: "nope" })).toThrow("SANDCHEST_SLICE_INDEXER_LINUX_SHA256");
  });

  test("the relay's port is not the indexer's: both run in the same sandbox", () => {
    expect(RELAY_PORT).not.toBe(INDEXER_PORT);
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

describe("fast mode", () => {
  const ceiling = { SANDCHEST_SLICE_CEILING_FAST_USD: "0.75" };
  const model = { LLM_AGENT_FAST_MODEL: "fast-model" };
  const agentBody = { LLM_AGENT_FAST_BODY: '{"serving":"fast"}' };
  const sliceFastBody = { LLM_SLICE_FAST_BODY: '{"serving":"fast"}' };

  test("unset, it does not exist, and nothing new is required", () => {
    expect(fastModeAvailable(config(base))).toBe(false);
    expect(fastModeAvailable(config(slice))).toBe(false);
    expect(fastModeAvailable(config({ ...slice, SANDCHEST_SLICE_CEILING_FAST_USD: " ", LLM_AGENT_FAST_MODEL: "", LLM_AGENT_FAST_BODY: "", LLM_SLICE_FAST_BODY: " " }))).toBe(false);
  });

  test("available only on the slice engine, with its ceiling, and with both the agent's and the engine's calls changed", () => {
    const available = (env: Record<string, string>) => fastModeAvailable(config({ ...slice, ...env }));
    expect(available({ ...ceiling, ...model })).toBe(true);
    expect(available({ ...ceiling, ...agentBody, ...sliceFastBody })).toBe(true);
    expect(available({ ...ceiling, ...model, ...agentBody, ...sliceFastBody })).toBe(true);
    // Only the agent's calls changed, or only the engine's.
    expect(available({ ...ceiling, ...agentBody })).toBe(false);
    expect(available({ ...ceiling, ...sliceFastBody })).toBe(false);
    // No ceiling of its own.
    expect(available({ ...model, ...agentBody, ...sliceFastBody })).toBe(false);
    // Not the slice engine: everything set still offers nothing.
    expect(fastModeAvailable(config({ ...base, ...ceiling, ...model, ...agentBody, ...sliceFastBody }))).toBe(false);
    expect(fastModeAvailable(config({ ...base, SANDCHEST_ENGINE: "classic", ...ceiling, ...model }))).toBe(false);
  });

  test("some fast settings without the rest are valid configuration, just not offered", () => {
    for (const env of [ceiling, model, agentBody, sliceFastBody, { ...ceiling, ...agentBody }]) {
      expect(() => config({ ...slice, ...env })).not.toThrow();
      expect(fastModeAvailable(config({ ...slice, ...env }))).toBe(false);
    }
  });

  test("a malformed fast ceiling or body is a configuration error", () => {
    for (const bad of ["0", "-1", "1e3", "abc", "1.1234567"]) expect(() => config({ ...slice, SANDCHEST_SLICE_CEILING_FAST_USD: bad })).toThrow("SANDCHEST_SLICE_CEILING_FAST_USD");
    for (const name of ["LLM_SLICE_FAST_BODY", "LLM_AGENT_FAST_BODY"]) {
      for (const bad of ["null", "[1]", "{nope", '"text"']) expect(() => config({ ...slice, ...ceiling, ...model, [name]: bad })).toThrow(`${name}: must be a JSON object`);
    }
    // As LLM_SLICE_BODY: the bodies are only read on the slice engine.
    expect(() => config({ ...base, LLM_SLICE_FAST_BODY: "null", LLM_AGENT_FAST_BODY: "null" })).not.toThrow();
  });

  test("the fast bodies never come from the standard ones", () => {
    const settings = config({ ...slice, ...ceiling, ...model, LLM_SLICE_BODY: '{"serving":"standard"}' });
    expect(settings.LLM_SLICE_FAST_BODY).toBeUndefined();
    expect(sliceBody(settings.LLM_SLICE_FAST_BODY)).toEqual({ body: {} });
    // A standard body alone makes nothing fast.
    expect(fastModeAvailable(config({ ...slice, ...ceiling, LLM_SLICE_BODY: '{"a":1}' }))).toBe(false);
  });

  test("a scan runs fast only when flagged, a deep scan, on the slice engine for its account, with fast mode available", () => {
    const on = config({ ...slice, ...ceiling, ...model });
    expect(fastRunAllowed({ fast: true, kind: "deep" }, "acme", on)).toBe(true);
    expect(fastRunAllowed({ fast: false, kind: "deep" }, "acme", on)).toBe(false);
    for (const kind of ["pr_review", "recon", "fix_check"]) expect(fastRunAllowed({ fast: true, kind }, "acme", on)).toBe(false);
    expect(fastRunAllowed({ fast: true, kind: "deep" }, "acme", config({ ...slice, ...ceiling, ...model, SANDCHEST_ENGINE_ORGS: "example-org" }))).toBe(false);
    expect(fastRunAllowed({ fast: true, kind: "deep" }, "acme", config({ ...slice, ...model }))).toBe(false);
    expect(fastRunAllowed({ fast: true, kind: "deep" }, "acme", config({ ...base, ...ceiling, ...model }))).toBe(false);
  });
});
