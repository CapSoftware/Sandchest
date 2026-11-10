/**
 * Writes a scan's usage ledger: every model call and its sandbox, with what
 * each cost. Records only. A write that fails is tried again, logged by error
 * name, and kept for the next flush; every row carries a key, so a row sent
 * twice is stored once. The scan's last flush reports how many rows were never
 * written. The ledger never fails or holds up a scan.
 */
import type { UsageInput } from "@sandchest/db";
import type { UsageEvent } from "@sandchest/engine/scan";
import type { BoatUsage } from "@sandchest/workspace/boat";
import { describeError } from "./log";

export interface UsageLedgerOptions {
  /** Writes one batch. */
  write: (rows: UsageInput[]) => Promise<void>;
  /** Names the scan in a failure's log line. */
  scanId: string;
  /** Rows that start a write at once. Default 50. */
  batchSize?: number;
  /** Longest a row waits to be written while the scan runs. Default 5 s. */
  delayMs?: number;
  /** The unit of work that can be run again, set on every row. Default `execute`. */
  step?: string;
  /** Which run of that step this is, set on every row. Default 0. */
  attempt?: number;
  log?: (line: string) => void;
  /** Waits between tries of a write. For tests. */
  wait?: (ms: number) => Promise<void>;
}

/** Waits before the second and third try of a write within one flush. */
const RETRY_DELAYS_MS = [100, 400];

export class UsageLedger {
  private queue: UsageInput[] = [];
  /** Batches taken from the queue and not yet written, oldest first. */
  private batches: UsageInput[][] = [];
  private writing: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly batchSize: number;
  private readonly delayMs: number;
  private readonly log: (line: string) => void;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(private readonly options: UsageLedgerOptions) {
    this.batchSize = options.batchSize ?? 50;
    this.delayMs = options.delayMs ?? 5_000;
    this.log = options.log ?? ((line) => console.error(line));
    this.wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** The engine's sink: one model call. */
  readonly onUsage = (event: UsageEvent): void => {
    this.add({
      kind: "model",
      stage: event.stage ?? event.role,
      role: event.role,
      inputTokens: event.inputTokens,
      cachedTokens: event.cachedTokens,
      outputTokens: event.outputTokens,
      reasoningTokens: event.reasoningTokens,
      costUsd: event.costUsd,
      costSource: event.costSource,
      status: event.status,
      createdAt: new Date(),
    });
  };

  /** The scan's sandbox, as its host metered it. */
  sandbox(usage: Pick<BoatUsage, "seconds" | "usd">): void {
    this.add({ kind: "sandbox", stage: "sandbox", role: null, seconds: usage.seconds, costUsd: usage.usd, costSource: "sandbox", createdAt: new Date() });
  }

  /**
   * Writes everything queued so far, after any write already under way. A batch that still fails
   * after its retries goes back to the front of the queue, with any batch behind it, in order, for
   * the next flush. Never rejects.
   */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const batch = this.queue;
    this.queue = [];
    if (batch.length === 0) return this.writing;
    this.batches.push(batch);
    this.writing = this.writing.then(() => this.drain());
    return this.writing;
  }

  /**
   * The scan's last flush: waits at most `timeoutMs` for the writes, so a stuck database never holds
   * the scan up. Resolves to the rows still not written, including any whose write was still under
   * way at the limit. Never rejects.
   */
  async close(timeoutMs = 10_000): Promise<{ unwritten: number }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), timeoutMs)));
    try {
      if ((await Promise.race([this.flush(), timeout])) === "timeout") this.log(`Usage ledger write for scan ${this.options.scanId} took too long`);
    } finally {
      clearTimeout(timer);
    }
    return { unwritten: this.queue.length + this.batches.reduce((sum, batch) => sum + batch.length, 0) };
  }

  /** Writes the waiting batches in order. On a failure, it and every batch behind it go back to the front of the queue. */
  private async drain(): Promise<void> {
    while (this.batches.length > 0) {
      const batch = this.batches[0]!;
      let failure: { error: unknown } | undefined;
      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
        if (attempt > 0) await this.wait(RETRY_DELAYS_MS[attempt - 1]!);
        try {
          await this.options.write(batch);
          failure = undefined;
          break;
        } catch (error) {
          failure = { error };
        }
      }
      if (failure) {
        this.log(`Usage ledger write for scan ${this.options.scanId} failed: ${describeError(failure.error)}`);
        this.queue = [...this.batches.flat(), ...this.queue];
        this.batches = [];
        return;
      }
      this.batches.shift();
    }
  }

  private add(row: UsageInput): void {
    // The key makes a write that is sent again harmless: a batch the database took before the connection failed is not stored twice.
    this.queue.push({ ...row, step: this.options.step ?? "execute", attempt: this.options.attempt ?? 0, key: crypto.randomUUID() });
    if (this.queue.length >= this.batchSize) void this.flush();
    else this.timer ??= setTimeout(() => void this.flush(), this.delayMs);
  }
}

/** A Boat sandbox's metered usage, read just before it is destroyed. Undefined when it can't be read in time. */
export async function readSandboxUsage(workspace: { usage(): Promise<BoatUsage> }, options: { scanId: string; timeoutMs?: number; log?: (line: string) => void }): Promise<BoatUsage | undefined> {
  const log = options.log ?? ((line: string) => console.error(line));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), options.timeoutMs ?? 10_000)));
  try {
    const usage = await Promise.race([workspace.usage(), timeout]);
    if (usage === "timeout") {
      log(`Sandbox usage for scan ${options.scanId} took too long to read`);
      return undefined;
    }
    return usage;
  } catch (error) {
    log(`Sandbox usage for scan ${options.scanId} could not be read: ${describeError(error)}`);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
