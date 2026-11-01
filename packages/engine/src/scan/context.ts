import type { IndexerClient } from "../indexer/client";
import type { LlmClient } from "../llm";
import type { Limiter, UsageMeter } from "./metrics";
import type { Finding } from "./schema";
import type { ChangedFile } from "./changes";
import type { AgentTool, Wrap } from "./tools";

export interface ScanLimits {
  /** Parallel hunters in the main pass, including access-control and leads hunters. Default 8. */
  maxHunters: number;
  /**
   * Model turns every hunter gets. Default 24. Each candidate it gets past
   * the evidence gate earns `turnsPerFinding` more, up to `hunterMaxTurns`:
   * hunters that keep finding bugs keep digging, while on clean code they
   * stop before the costly long tail (every turn resends the conversation).
   */
  hunterTurns: number;
  /** Default 6. */
  turnsPerFinding: number;
  /** Default 40. */
  hunterMaxTurns: number;
  /** Model turns per coverage hunter. Default 20. */
  coverageTurns: number;
  /** Model turns per skeptic review. Default 10. */
  skepticTurns: number;
  /** Model turns for recon exploration. Default 10. */
  reconTurns: number;
  /** Model requests in flight at once across the scan. Default 12. */
  concurrency: number;
  /** Largest repository scanned, in lines of hand-written code. Default 1,000,000. */
  maxLoc: number;
  /** PR reviews: hunters at most. Default 3. */
  prMaxHunters: number;
  /** PR reviews: changed lines reviewed before narrowing to the riskiest files. Default 5,000. */
  prLineCap: number;
  /**
   * Wall-clock ceiling for the scan. Typical scans finish far inside it; it
   * bounds the worst case. The main hunt stops at 55% of it, the coverage
   * pass at 75%, and candidates still unreviewed at 90% are kept at low
   * confidence. Default 15 minutes.
   */
  timeBudgetMs: number;
}

export const DEFAULT_LIMITS: ScanLimits = {
  maxHunters: 8,
  hunterTurns: 24,
  turnsPerFinding: 6,
  hunterMaxTurns: 40,
  coverageTurns: 20,
  skepticTurns: 10,
  reconTurns: 10,
  concurrency: 12,
  maxLoc: 1_000_000,
  prMaxHunters: 3,
  prLineCap: 5_000,
  timeBudgetMs: 15 * 60_000,
};

/** Progress for the live feed: calm, readable, never code. */
export type ScanEvent =
  | { type: "stage"; stage: "index" | "sweep" | "recon" | "hunt" | "coverage" | "verify" | "done"; message: string }
  | { type: "progress"; message: string }
  | { type: "finding"; finding: Finding }
  | { type: "warning"; message: string };

/** Everything a stage needs, shared across the scan's agents. */
export interface ScanContext {
  client: LlmClient;
  indexer: IndexerClient;
  /** Read-only exploration tools. */
  tools: AgentTool[];
  limiter: Limiter;
  meter: UsageMeter;
  options: ScanLimits;
  signal?: AbortSignal;
  /** Untrusted-data tag, unique to this scan. */
  tag: string;
  wrap: Wrap;
  /** Rendered threat model; part of the cached prompt prefix. */
  threatModelText: string;
  counters: { rejected: number; duplicates: number };
  /** PR reviews: the files under review. Findings must touch them. */
  change?: ChangedFile[];
  emit(event: ScanEvent): void;
}
