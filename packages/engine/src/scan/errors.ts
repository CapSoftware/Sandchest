import { isIndexerDown } from "../indexer/client";
import { LlmQuotaError } from "../llm";

/**
 * Errors that end the whole scan: it was cancelled, the model endpoint
 * refused for billing or quota reasons, or the indexer is gone. Anything
 * else is contained to the agent or candidate it happened in.
 */
export function isFatal(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || error instanceof LlmQuotaError || isIndexerDown(error);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The scan's signal, also aborted at `deadline` (epoch ms): for a model call
 * that must not run past a stage's budget. A deadline abort is not fatal, so
 * callers check fatality against the scan's own signal, never this one.
 */
export function untilDeadline(signal: AbortSignal | undefined, deadline: number | undefined): AbortSignal | undefined {
  if (deadline === undefined || !Number.isFinite(deadline)) return signal;
  const timer = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  return signal ? AbortSignal.any([signal, timer]) : timer;
}
