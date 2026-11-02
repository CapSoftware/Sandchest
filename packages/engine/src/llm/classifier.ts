/**
 * A typed-decision classifier: a fast model that, given a piece of code as
 * state and a set of yes/no (`noul`) or multiple-choice (`choice`) questions,
 * returns a calibrated probability or a chosen option per question — never
 * prose. We use it to answer cheap, neutral, structural questions about code
 * ("is this an HTTP handler?") at scale, language-agnostically, where the
 * deterministic indexer's framework-specific rules fall short.
 *
 * Provider-agnostic: the endpoint URL, key and model are read from
 * `LLM_CLASSIFIER_URL` / `LLM_CLASSIFIER_KEY` / `LLM_CLASSIFIER_MODEL`. When
 * they are unset the classifier is simply absent and callers skip it, so the
 * scan works unchanged. The wire format is a typed-decision protocol:
 * `POST { model, state, questions }` → `{ answers }`, each answer carrying a
 * probability (`noul`) or a chosen option (`choice`).
 */

export interface NoulQuestion {
  type: "noul";
  instructions: string;
}
export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  /** Option id → what it means. The answer is one of these ids. */
  criteria: Record<string, string>;
}
export type ClassifierQuestion = NoulQuestion | ChoiceQuestion;

export interface NoulAnswer {
  type: "noul";
  /** Probability in [0, 1] that the answer is yes. */
  noul: number;
}
export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}
export type ClassifierAnswer = NoulAnswer | ChoiceAnswer;

export interface ClassifierResult {
  answers: Record<string, ClassifierAnswer>;
  /** Input tokens billed, for cost accounting. */
  inputTokens: number;
}

export interface ClassifierConfig {
  /** Full POST URL of the typed-decision endpoint. */
  url: string;
  apiKey: string;
  model: string;
  /** Opt-in header to raise the context limit for an oversized state. */
  longContextHeader?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  fetch?: typeof fetch;
}

export interface Classifier {
  ask(state: string, questions: Record<string, ClassifierQuestion>, signal?: AbortSignal): Promise<ClassifierResult>;
  readonly model: string;
}

/**
 * Reads classifier configuration from the environment. Returns `null` (not an
 * error) when it is not configured, so the feature is optional.
 */
export function loadClassifierConfig(env: Record<string, string | undefined> = process.env): ClassifierConfig | null {
  const url = env.LLM_CLASSIFIER_URL?.trim();
  const apiKey = env.LLM_CLASSIFIER_KEY?.trim();
  const model = env.LLM_CLASSIFIER_MODEL?.trim();
  if (!url || !apiKey || !model) return null;
  return { url, apiKey, model, longContextHeader: env.LLM_CLASSIFIER_LONG_CONTEXT_HEADER?.trim() || undefined };
}

export class ClassifierError extends Error {
  override readonly name = "ClassifierError";
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** Characters of state above which we flip on the long-context header, if configured. */
const LONG_CONTEXT_CHARS = 100_000;

export function createClassifier(config: ClassifierConfig): Classifier {
  const fetchImpl = config.fetch ?? fetch;
  const timeoutMs = config.timeoutMs ?? 20_000;
  const maxAttempts = config.maxAttempts ?? 3;

  async function attempt(state: string, questions: Record<string, ClassifierQuestion>, signal?: AbortSignal): Promise<ClassifierResult> {
    const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` };
    if (config.longContextHeader && state.length > LONG_CONTEXT_CHARS) headers[config.longContextHeader] = "true";
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(config.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: config.model, state, questions }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw new ClassifierError(`classifier unreachable: ${(error as Error).message}`, true);
    }
    const json = (await response.json().catch(() => undefined)) as { answers?: Record<string, ClassifierAnswer>; usage?: { input_tokens?: number } } | undefined;
    if (!response.ok || !json?.answers) {
      const detail = json ? JSON.stringify(json).slice(0, 200) : `status ${response.status}`;
      // 4xx is our bug (bad question) and not worth retrying; 5xx / rate limits are.
      throw new ClassifierError(`classifier ${response.status}: ${detail}`, response.status >= 500 || response.status === 429);
    }
    return { answers: json.answers, inputTokens: json.usage?.input_tokens ?? 0 };
  }

  return {
    model: config.model,
    async ask(state, questions, signal) {
      for (let n = 1; ; n++) {
        try {
          return await attempt(state, questions, signal);
        } catch (error) {
          const retryable = error instanceof ClassifierError && error.retryable;
          if (!retryable || n >= maxAttempts || signal?.aborted) throw error;
          await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** n));
        }
      }
    },
  };
}
