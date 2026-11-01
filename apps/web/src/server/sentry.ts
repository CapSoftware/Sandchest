/**
 * Server-side error reports to Sentry, when SENTRY_DSN is set; otherwise
 * every call returns at once. Reads the environment directly rather than
 * `config()`, so a deployment with a broken configuration can still report
 * it. Never throws and never waits more than two seconds.
 */
import { cleanTags, envelope, exceptionValues, parseDsn, signature, type Dsn, type SentryEvent } from "@/lib/sentry";

/** At most this many events per minute from one server instance, and one per distinct error. */
const PER_MINUTE = 30;
const TIMEOUT_MS = 2_000;

let state: { dsn: Dsn | undefined; source: string | undefined } | undefined;
const recent = new Map<string, number>();
let windowStart = 0;
let sentInWindow = 0;

function dsn(): Dsn | undefined {
  const source = process.env.SENTRY_DSN;
  if (!state || state.source !== source) state = { dsn: parseDsn(source), source };
  return state.dsn;
}

export function sentryEnabled(): boolean {
  return dsn() !== undefined;
}

export interface CaptureContext {
  /** Where it happened: "request", "workflow", "billing", ... */
  source: string;
  /** Enums, route patterns and opaque ids only. */
  tags?: Record<string, string | number | boolean | undefined>;
  /** Caught and dealt with (the work carried on) rather than a failure. */
  handled?: boolean;
}

/** Reports an error. Resolves once sent, dropped or timed out. */
export async function captureException(error: unknown, context: CaptureContext): Promise<void> {
  const target = dsn();
  if (!target) return;
  try {
    // Messages are withheld unless known to be safe (see `safeMessage`): a scan's errors quote repositories, refs and paths.
    const values = exceptionValues(error, { type: context.source, handled: context.handled ?? false });
    if (!admit(signature(values))) return;
    const event: SentryEvent = {
      event_id: crypto.randomUUID().replace(/-/g, ""),
      timestamp: Date.now() / 1000,
      platform: "node",
      level: context.handled ? "warning" : "error",
      environment: process.env.SENTRY_ENVIRONMENT || process.env.VERCEL_ENV || process.env.NODE_ENV,
      release: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12),
      exception: { values },
      tags: cleanTags({ source: context.source, runtime: process.env.NEXT_RUNTIME || "nodejs", ...context.tags }),
      sdk: { name: "sandchest.sentry", version: "1" },
    };
    await fetch(target.endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-sentry-envelope" },
      body: envelope(event, target),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => {});
  } catch {
    // Reporting must never become the error.
  }
}

/** Rate limit and de-duplication: the same error is sent once a minute, and no more than PER_MINUTE events in all. */
function admit(key: string, now = Date.now()): boolean {
  if (now - windowStart > 60_000) {
    windowStart = now;
    sentInWindow = 0;
    for (const [seen, at] of recent) if (now - at > 60_000) recent.delete(seen);
  }
  if (sentInWindow >= PER_MINUTE || (recent.get(key) ?? 0) > now - 60_000) return false;
  sentInWindow++;
  recent.set(key, now);
  return true;
}

/** For tests. */
export function resetSentry(): void {
  state = undefined;
  recent.clear();
  windowStart = 0;
  sentInWindow = 0;
}
