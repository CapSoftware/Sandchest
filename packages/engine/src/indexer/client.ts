/**
 * Client for the `sandchest-index` daemon: `POST /<tool>` with JSON in and out.
 * The daemon runs next to the checkout (a local process or inside the scan's
 * sandbox), so calls take milliseconds.
 */

export interface IndexerClient {
  /** Calls a tool. Rejects with `IndexerError`. */
  call<T = unknown>(tool: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
  /** Resolves once the index is built. */
  ready(signal?: AbortSignal): Promise<void>;
}

export class IndexerError extends Error {
  override readonly name = "IndexerError";

  constructor(
    message: string,
    /**
     * `bad_request`: the arguments were rejected; the caller (or the model) can correct them.
     * `unavailable`: the daemon cannot be reached or failed internally; the scan cannot continue reliably.
     */
    readonly kind: "bad_request" | "unavailable",
  ) {
    super(message);
  }
}

export interface HttpIndexerOptions {
  /** Base URL, e.g. `http://127.0.0.1:4100`. */
  url: string;
  token?: string;
  /** Per-call timeout. Default 30s: index-backed tools wait for indexing to finish. */
  timeoutMs?: number;
  /** Attempts per call for connection failures and 5xx responses. Default 3. */
  maxAttempts?: number;
  fetch?: typeof fetch;
}

export function createIndexerClient(options: HttpIndexerOptions): IndexerClient {
  const fetchImpl = options.fetch ?? fetch;
  const base = options.url.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxAttempts = options.maxAttempts ?? 3;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  async function attempt<T>(tool: string, body: string, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${base}/${tool}`, { method: "POST", body, headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw new IndexerError(`Indexer unreachable: ${(error as Error).message}`, "unavailable");
    }
    const parsed = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
    if (response.ok && parsed) return parsed as T;
    const message = parsed?.error ?? `Indexer returned ${response.status}`;
    throw new IndexerError(message, response.status >= 400 && response.status < 500 ? "bad_request" : "unavailable");
  }

  async function call<T>(tool: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const body = JSON.stringify(args);
    for (let attemptNumber = 1; ; attemptNumber++) {
      try {
        return await attempt<T>(tool, body, signal);
      } catch (error) {
        const retryable = error instanceof IndexerError && error.kind === "unavailable";
        if (!retryable || attemptNumber >= maxAttempts || signal?.aborted) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attemptNumber));
      }
    }
  }

  return {
    call,
    async ready(signal) {
      // `overview` blocks server-side until the index exists.
      await call("overview", {}, signal);
    },
  };
}

/** Whether an error means the indexer is gone, rather than one call being wrong. */
export function isIndexerDown(error: unknown): boolean {
  return error instanceof IndexerError && error.kind === "unavailable";
}
