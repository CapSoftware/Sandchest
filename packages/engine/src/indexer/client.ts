/**
 * Client for the `sandchest-index` daemon: `POST /<tool>` with JSON in and out.
 * The daemon runs next to the checkout (a local process or inside the scan's
 * sandbox), so calls take milliseconds.
 */

export interface IndexerClient {
  /** Calls a tool. Rejects with `IndexerError` when the tool reports a problem with the arguments. */
  call<T = unknown>(tool: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
  /** Resolves once the index is built. */
  ready(signal?: AbortSignal): Promise<void>;
}

export class IndexerError extends Error {
  override readonly name = "IndexerError";

  constructor(
    message: string,
    /** The arguments were rejected (a 4xx): the caller, or the model, can correct them. */
    readonly badRequest: boolean,
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
  fetch?: typeof fetch;
}

export function createIndexerClient(options: HttpIndexerOptions): IndexerClient {
  const fetchImpl = options.fetch ?? fetch;
  const base = options.url.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 30_000;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  async function request<T>(path: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(`${base}/${path}`, { ...init, headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) {
      throw new IndexerError(body.error ?? `Indexer returned ${response.status}`, response.status >= 400 && response.status < 500);
    }
    return body as T;
  }

  return {
    call(tool, args = {}, signal) {
      return request(tool, { method: "POST", body: JSON.stringify(args) }, signal);
    },
    async ready(signal) {
      // `overview` blocks server-side until the index exists.
      await request("overview", { method: "POST", body: "{}" }, signal);
    },
  };
}
