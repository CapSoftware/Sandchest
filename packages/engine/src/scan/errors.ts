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
