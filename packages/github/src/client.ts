/**
 * A small GitHub REST client: retries with backoff on network errors, 5xx
 * and rate limits (honouring `retry-after` and the rate-limit reset), a
 * timeout per request, and pagination by `Link` header.
 */

const API = "https://api.github.com";

export class GitHubError extends Error {
  override readonly name = "GitHubError";

  constructor(
    message: string,
    readonly status: number,
    /** Retrying the same request may succeed. */
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Extra headers, e.g. a different `accept`. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface HttpOptions {
  fetch?: typeof fetch;
  /** Attempts per request, including the first. Default 4. */
  maxAttempts?: number;
  /** Per-attempt timeout. Default 30s. */
  timeoutMs?: number;
  /** Longest wait before a retry, including a rate-limit reset. Default 60s. */
  maxBackoffMs?: number;
}

/** Sends one authenticated API request. `auth` is called per attempt so a refreshed token is used on retry. */
export async function githubRequest<T>(auth: () => Promise<string>, path: string, options: RequestOptions = {}, http: HttpOptions = {}): Promise<T> {
  const { response } = await send(auth, path, options, http);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Follows `Link: rel="next"` until `limit` items. `pick` extracts the items from each page. */
export async function githubPaginate<T, P = T[]>(
  auth: () => Promise<string>,
  path: string,
  pick: (page: P) => T[],
  options: { limit?: number; signal?: AbortSignal } = {},
  http: HttpOptions = {},
): Promise<T[]> {
  const items: T[] = [];
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  let next: string | undefined = path.includes("?") ? `${path}&per_page=100` : `${path}?per_page=100`;
  while (next && items.length < limit) {
    const { response } = await send(auth, next, { signal: options.signal }, http);
    items.push(...pick((await response.json()) as P));
    next = nextLink(response.headers.get("link"));
  }
  return items.slice(0, limit);
}

async function send(auth: () => Promise<string>, path: string, options: RequestOptions, http: HttpOptions): Promise<{ response: Response }> {
  const fetchImpl = http.fetch ?? fetch;
  const maxAttempts = http.maxAttempts ?? 4;
  const timeoutMs = http.timeoutMs ?? 30_000;
  const maxBackoffMs = http.maxBackoffMs ?? 60_000;
  const url = path.startsWith("https://") ? path : `${API}${path}`;

  for (let attempt = 1; ; attempt++) {
    let failure: GitHubError;
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      const response = await fetchImpl(url, {
        method: options.method ?? "GET",
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "sandchest",
          authorization: `Bearer ${await auth()}`,
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
          ...options.headers,
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      });
      if (response.ok) return { response };
      failure = await errorFrom(response);
      if (!failure.retryable || attempt >= maxAttempts) throw failure;
      await wait(Math.min(maxBackoffMs, retryDelay(response, attempt)), options.signal);
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (error instanceof GitHubError) throw error;
      // Network error or timeout.
      if (attempt >= maxAttempts) throw new GitHubError(`GitHub request failed: ${(error as Error).message}`, 0, true);
      await wait(Math.min(maxBackoffMs, backoff(attempt)), options.signal);
    }
  }
}

async function errorFrom(response: Response): Promise<GitHubError> {
  const text = (await response.text().catch(() => "")).slice(0, 500);
  let message = text;
  try {
    message = (JSON.parse(text) as { message?: string }).message ?? text;
  } catch {
    // Not JSON.
  }
  const rateLimited =
    response.status === 429 || (response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(message)));
  const retryable = rateLimited || (response.status >= 500 && response.status !== 501);
  return new GitHubError(`GitHub ${response.status}: ${message}`, response.status, retryable);
}

/** `retry-after` (seconds), else the primary rate-limit reset, else exponential backoff. */
function retryDelay(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (retryAfter > 0) return retryAfter * 1000;
  if (response.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    if (reset > 0) return Math.max(0, reset * 1000 - Date.now()) + 1000;
  }
  return backoff(attempt);
}

function backoff(attempt: number): number {
  return Math.round((500 * 2 ** (attempt - 1)) * (0.5 + Math.random()));
}

function nextLink(header: string | null): string | undefined {
  return header?.split(",").find((part) => part.includes('rel="next"'))?.match(/<([^>]+)>/)?.[1];
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
