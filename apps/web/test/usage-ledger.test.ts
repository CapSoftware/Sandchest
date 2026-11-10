/** The scan's usage ledger: model calls and the sandbox are buffered and written in batches, and a failed write never fails the scan. */
import { describe, expect, test } from "bun:test";
import type { UsageInput } from "@sandchest/db";
import type { UsageEvent } from "@sandchest/engine/scan";
import { readSandboxUsage, UsageLedger } from "@/server/usage-ledger";

const call = (overrides: Partial<UsageEvent> = {}): UsageEvent => ({
  role: "hunt",
  stage: "hunt",
  inputTokens: 100,
  cachedTokens: 80,
  outputTokens: 10,
  reasoningTokens: 3,
  costUsd: 0.000125,
  costSource: "priced",
  ...overrides,
});

function recording(options: { fail?: () => boolean; batchSize?: number; delayMs?: number } = {}) {
  const batches: UsageInput[][] = [];
  const logs: string[] = [];
  const ledger = new UsageLedger({
    scanId: "scan-1",
    batchSize: options.batchSize ?? 3,
    delayMs: options.delayMs ?? 60_000,
    log: (line) => logs.push(line),
    write: async (rows) => {
      if (options.fail?.()) throw Object.assign(new Error("connection to user@example.com refused: payload"), { name: "PostgresError" });
      batches.push(rows);
    },
  });
  return { ledger, batches, logs };
}

describe("UsageLedger", () => {
  test("writes a batch once it fills, and the rest on flush", async () => {
    const { ledger, batches } = recording();
    for (let i = 0; i < 4; i++) ledger.onUsage(call());
    await ledger.flush();
    expect(batches.map((batch) => batch.length)).toEqual([3, 1]);
  });

  test("each call becomes one model row with its role, stage, tokens and cost", async () => {
    const { ledger, batches } = recording();
    ledger.onUsage(call({ role: "skeptic", stage: "review", costUsd: 0.5, costSource: "provider" }));
    ledger.onUsage(call({ role: "recon", stage: undefined }));
    await ledger.flush();
    expect(batches.flat()).toMatchObject([
      { kind: "model", stage: "review", role: "skeptic", inputTokens: 100, cachedTokens: 80, outputTokens: 10, reasoningTokens: 3, costUsd: 0.5, costSource: "provider" },
      // A call with no known stage is filed under its role.
      { kind: "model", stage: "recon", role: "recon", costSource: "priced" },
    ]);
  });

  test("a quiet scan's rows are written after the delay, without a flush", async () => {
    const { ledger, batches } = recording({ delayMs: 5 });
    ledger.onUsage(call());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(batches.flat()).toHaveLength(1);
  });

  test("a failed write is logged by error name only, never thrown, and later writes still go", async () => {
    let failing = true;
    const { ledger, batches, logs } = recording({ fail: () => failing });
    ledger.onUsage(call());
    await expect(ledger.flush()).resolves.toBeUndefined();
    expect(logs).toEqual(["Usage ledger write for scan scan-1 failed: PostgresError"]);
    expect(logs.join("\n")).not.toContain("example.com");
    failing = false;
    ledger.onUsage(call());
    await ledger.flush();
    expect(batches.flat()).toHaveLength(1);
  });

  test("a write that never finishes neither blocks adding rows nor holds the scan's last flush past its limit", async () => {
    const logs: string[] = [];
    const ledger = new UsageLedger({ scanId: "scan-1", batchSize: 1, log: (line) => logs.push(line), write: () => new Promise(() => {}) });
    expect(() => {
      for (let i = 0; i < 5; i++) ledger.onUsage(call());
    }).not.toThrow();
    const started = Date.now();
    await ledger.close(20);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(logs).toEqual(["Usage ledger write for scan scan-1 took too long"]);
  });

  test("the sandbox is one row with its seconds and dollars", async () => {
    const { ledger, batches } = recording();
    ledger.sandbox({ seconds: 312.5, usd: 0.0425 });
    await ledger.flush();
    expect(batches.flat()).toMatchObject([{ kind: "sandbox", stage: "sandbox", role: null, seconds: 312.5, costUsd: 0.0425, costSource: "sandbox" }]);
  });

  test("flush with nothing queued writes nothing", async () => {
    const { ledger, batches } = recording();
    await ledger.flush();
    expect(batches).toEqual([]);
  });
});

describe("readSandboxUsage", () => {
  test("returns the sandbox's meter", async () => {
    const usage = await readSandboxUsage({ usage: async () => ({ seconds: 10, usd: 0.01, running: true }) }, { scanId: "scan-1", log: () => {} });
    expect(usage).toEqual({ seconds: 10, usd: 0.01, running: true });
  });

  test("a meter that fails or hangs is logged and skipped", async () => {
    const logs: string[] = [];
    const failed = await readSandboxUsage({ usage: async () => { throw Object.assign(new Error("secret detail"), { name: "BoatApiError", status: 503 }); } }, { scanId: "scan-1", log: (line) => logs.push(line) });
    const hung = await readSandboxUsage({ usage: () => new Promise(() => {}) }, { scanId: "scan-1", timeoutMs: 5, log: (line) => logs.push(line) });
    expect([failed, hung]).toEqual([undefined, undefined]);
    expect(logs).toEqual(["Sandbox usage for scan scan-1 could not be read: BoatApiError 503", "Sandbox usage for scan scan-1 took too long to read"]);
  });
});
