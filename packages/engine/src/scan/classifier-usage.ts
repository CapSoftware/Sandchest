/** The entry-point classifier's calls, metered like model calls. */
import type { Classifier } from "../llm";
import type { UsageEvent, UsageSink } from "./metrics";

/**
 * A classifier that reports each `ask` to `onUsage` as a `classifier` call, priced at
 * `pricePerMillionInput` USD per million input tokens (0 with no price). A failed ask is reported
 * with no tokens and rethrown. A sink that throws never fails the ask.
 */
export function meteredClassifier(inner: Classifier, onUsage: UsageSink, pricePerMillionInput: number | undefined): Classifier {
  const report = (inputTokens: number, status: UsageEvent["status"]) => {
    try {
      onUsage({
        role: "classifier",
        stage: "classify",
        inputTokens,
        cachedTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        costUsd: (inputTokens * (pricePerMillionInput ?? 0)) / 1_000_000,
        costSource: "priced",
        status,
      });
    } catch {
      // Recording usage never costs the scan a classifier call.
    }
  };
  return {
    model: inner.model,
    async ask(state, questions, signal) {
      let result: Awaited<ReturnType<Classifier["ask"]>>;
      try {
        result = await inner.ask(state, questions, signal);
      } catch (error) {
        report(0, signal?.aborted ? "aborted" : "failed");
        throw error;
      }
      report(result.inputTokens, "ok");
      return result;
    },
  };
}

/** Reads the optional `LLM_CLASSIFIER_PRICE_INPUT` (USD per million input tokens). */
export function loadClassifierPrice(env: Record<string, string | undefined> = process.env): number | undefined {
  const raw = env.LLM_CLASSIFIER_PRICE_INPUT?.trim();
  if (!raw) return undefined;
  const price = Number(raw);
  return Number.isFinite(price) && price >= 0 ? price : undefined;
}
