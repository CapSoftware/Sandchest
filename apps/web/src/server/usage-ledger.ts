/**
 * Writes a scan's usage ledger: every model call and its sandbox, with what
 * each cost. Records only. A write that fails is logged by error name and
 * dropped: the ledger never fails or holds up a scan.
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
  log?: (line: string) => void;
}

export class UsageLedger {
  private queue: UsageInput[] = [];
  private writing: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly batchSize: number;
  private readonly delayMs: number;
  private readonly log: (line: string) => void;

  constructor(private readonly options: UsageLedgerOptions) {
    this.batchSize = options.batchSize ?? 50;
    this.delayMs = options.delayMs ?? 5_000;
    this.log = options.log ?? ((line) => console.error(line));
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
      createdAt: new Date(),
    });
  };

  /** The scan's sandbox, as its host metered it. */
  sandbox(usage: Pick<BoatUsage, "seconds" | "usd">): void {
    this.add({ kind: "sandbox", stage: "sandbox", role: null, seconds: usage.seconds, costUsd: usage.usd, costSource: "sandbox", createdAt: new Date() });
  }

  /** Writes everything queued so far, after any write already under way. Never rejects. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const batch = this.queue;
    this.queue = [];
    if (batch.length === 0) return this.writing;
    this.writing = this.writing.then(async () => {
      try {
        await this.options.write(batch);
      } catch (error) {
        this.log(`Usage ledger write for scan ${this.options.scanId} failed: ${describeError(error)}`);
      }
    });
    return this.writing;
  }

  /** The scan's last flush: waits at most `timeoutMs` for the writes, so a stuck database never holds the scan up. */
  async close(timeoutMs = 10_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), timeoutMs)));
    try {
      if ((await Promise.race([this.flush(), timeout])) === "timeout") this.log(`Usage ledger write for scan ${this.options.scanId} took too long`);
    } finally {
      clearTimeout(timer);
    }
  }

  private add(row: UsageInput): void {
    this.queue.push(row);
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
