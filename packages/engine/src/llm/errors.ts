export class LlmError extends Error {
  override readonly name: string = "LlmError";

  constructor(
    message: string,
    readonly options: {
      status?: number;
      /** Safe to repeat the request unchanged. */
      retryable: boolean;
      /** Server-requested delay before retrying. */
      retryAfterMs?: number;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
  }

  get status(): number | undefined {
    return this.options.status;
  }

  get retryable(): boolean {
    return this.options.retryable;
  }
}

/**
 * The endpoint refused the request for billing or quota reasons.
 * Retrying will not help: the scan should pause and the org owner be notified.
 */
export class LlmQuotaError extends LlmError {
  override readonly name = "LlmQuotaError";
}

const MAX_ERROR_BODY = 2_000;

/** Builds the error for a non-2xx response. */
export async function errorFromResponse(response: Response): Promise<LlmError> {
  const body = (await response.text().catch(() => "")).slice(0, MAX_ERROR_BODY);
  const status = response.status;
  const message = `Model request failed with ${status}: ${extractMessage(body)}`;

  if (status === 402 || (status === 429 && /quota|billing|credit/i.test(body))) {
    return new LlmQuotaError(message, { status, retryable: false });
  }

  const retryable = status === 408 || status === 409 || status === 429 || status >= 500;
  return new LlmError(message, { status, retryable, retryAfterMs: parseRetryAfter(response.headers) });
}

function extractMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    const error = parsed.error;
    const message = typeof error === "string" ? error : (error?.message ?? parsed.message);
    if (typeof message === "string" && message) return message;
  } catch {
    // Not JSON; fall through to the raw body.
  }
  return body || "(empty body)";
}

/** Reads `retry-after-ms` or `retry-after` (delta-seconds or HTTP date). */
export function parseRetryAfter(headers: Headers, now = Date.now()): number | undefined {
  const ms = Number(headers.get("retry-after-ms"));
  if (ms > 0) return ms;

  const value = headers.get("retry-after");
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
