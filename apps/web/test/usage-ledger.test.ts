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
  status: "ok",
  ...overrides,
});

function recording(options: { fail?: () => boolean; batchSize?: number; delayMs?: number; step?: string; attempt?: number } = {}) {
  const batches: UsageInput[][] = [];
  const logs: string[] = [];
  const waits: number[] = [];
  let tries = 0;
  const ledger = new UsageLedger({
    scanId: "scan-1",
    batchSize: options.batchSize ?? 3,
    delayMs: options.delayMs ?? 60_000,
    step: options.step,
    attempt: options.attempt,
    log: (line) => logs.push(line),
    wait: async (ms) => void waits.push(ms),
    write: async (rows) => {
      tries++;
      if (options.fail?.()) throw Object.assign(new Error("connection to user@example.com refused: payload"), { name: "PostgresError" });
      batches.push(rows);
    },
  });
  return { ledger, batches, logs, waits, tries: () => tries };
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

  test("a failed write is logged by error name only, never thrown, and its rows go with the next write, in order", async () => {
    let failing = true;
    const { ledger, batches, logs } = recording({ fail: () => failing });
    ledger.onUsage(call({ stage: "first" }));
    await expect(ledger.flush()).resolves.toBeUndefined();
    expect(logs).toEqual(["Usage ledger write for scan scan-1 failed: PostgresError"]);
    expect(logs.join("\n")).not.toContain("example.com");
    failing = false;
    ledger.onUsage(call({ stage: "second" }));
    await ledger.flush();
    expect(batches.flat().map((row) => row.stage)).toEqual(["first", "second"]);
    expect(logs).toHaveLength(1);
  });

  test("a write is tried three times within one flush, waiting 100 ms then 400 ms", async () => {
    let failures = 2;
    const { ledger, batches, logs, waits, tries } = recording({ fail: () => failures-- > 0 });
    ledger.onUsage(call());
    await ledger.flush();
    expect(tries()).toBe(3);
    expect(waits).toEqual([100, 400]);
    expect(batches.flat()).toHaveLength(1);
    expect(logs).toEqual([]);
  });

  test("a batch that still fails goes back to the front of the queue with every batch behind it, in order", async () => {
    let failing = true;
    const { ledger, batches, logs, tries } = recording({ fail: () => failing, batchSize: 2 });
    // Two full batches start writes; the fifth row goes with the flush.
    for (const stage of ["a", "b", "c", "d", "e"]) ledger.onUsage(call({ stage }));
    await ledger.flush();
    // The first batch's three tries fail; the batch behind it is not tried in the same flush.
    expect(tries()).toBe(3);
    expect(logs).toEqual(["Usage ledger write for scan scan-1 failed: PostgresError"]);
    failing = false;
    ledger.onUsage(call({ stage: "f" }));
    await ledger.flush();
    expect(batches.flat().map((row) => row.stage)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  test("close reports the rows it could not write, and none once they are written", async () => {
    let failing = true;
    const { ledger, batches } = recording({ fail: () => failing });
    ledger.onUsage(call());
    ledger.sandbox({ seconds: 1, usd: 0.001 });
    await expect(ledger.close()).resolves.toEqual({ unwritten: 2 });
    failing = false;
    await expect(ledger.close()).resolves.toEqual({ unwritten: 0 });
    expect(batches.flat()).toHaveLength(2);
  });

  test("every row has a key of its own, kept when its batch is written again", async () => {
    let failing = true;
    const { ledger, batches } = recording({ fail: () => failing, batchSize: 10 });
    for (let i = 0; i < 3; i++) ledger.onUsage(call());
    ledger.sandbox({ seconds: 1, usd: 0.001 });
    await ledger.flush();
    failing = false;
    await ledger.flush();
    const keys = batches.flat().map((row) => row.key);
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(4);
    for (const key of keys) expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("every row carries the ledger's step and attempt, by default execute and 0", async () => {
    const retried = recording({ step: "verify-agent", attempt: 2 });
    retried.ledger.onUsage(call());
    retried.ledger.sandbox({ seconds: 1, usd: 0.001 });
    await retried.ledger.flush();
    expect(retried.batches.flat()).toMatchObject([
      { kind: "model", step: "verify-agent", attempt: 2 },
      { kind: "sandbox", step: "verify-agent", attempt: 2 },
    ]);
    const first = recording();
    first.ledger.onUsage(call());
    await first.ledger.flush();
    expect(first.batches.flat()).toMatchObject([{ step: "execute", attempt: 0 }]);
  });

  test("a call's status is the row's status", async () => {
    const { ledger, batches } = recording({ batchSize: 10 });
    for (const status of ["ok", "failed", "aborted", "unpriced"] as const) ledger.onUsage(call({ status }));
    await ledger.flush();
    expect(batches.flat().map((row) => row.status)).toEqual(["ok", "failed", "aborted", "unpriced"]);
  });

  test("a write that never finishes neither blocks adding rows nor holds the scan's last flush past its limit", async () => {
    const logs: string[] = [];
    const ledger = new UsageLedger({ scanId: "scan-1", batchSize: 1, log: (line) => logs.push(line), write: () => new Promise(() => {}) });
    expect(() => {
      for (let i = 0; i < 5; i++) ledger.onUsage(call());
    }).not.toThrow();
    const started = Date.now();
    await expect(ledger.close(20)).resolves.toEqual({ unwritten: 5 });
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
