import type { IndexerClient } from "../indexer/client";
import type { LlmClient } from "../llm";
import type { Limiter, UsageMeter } from "./metrics";
import type { Finding } from "./schema";
import type { AgentTool, Wrap } from "./tools";

export interface ScanLimits {
  /** Parallel hunters, including the access-control and leads hunters. Default 8. */
  maxHunters: number;
  /** Model turns per hunter. Default 40. */
  hunterTurns: number;
  /** Model turns per skeptic review. Default 12. */
  skepticTurns: number;
  /** Model turns for recon exploration. Default 10. */
  reconTurns: number;
  /** Model requests in flight at once across the scan. Default 8. */
  concurrency: number;
  /** Largest repository scanned, in lines of hand-written code. Default 1,000,000. */
  maxLoc: number;
}

export const DEFAULT_LIMITS: ScanLimits = {
  maxHunters: 8,
  hunterTurns: 40,
  skepticTurns: 12,
  reconTurns: 10,
  concurrency: 8,
  maxLoc: 1_000_000,
};

/** Progress for the live feed: calm, readable, never code. */
export type ScanEvent =
  | { type: "stage"; stage: "index" | "sweep" | "recon" | "hunt" | "verify" | "done"; message: string }
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
  emit(event: ScanEvent): void;
}
