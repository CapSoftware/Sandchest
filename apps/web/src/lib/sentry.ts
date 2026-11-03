/**
 * Error reports in Sentry's envelope format, without Sentry's SDK. The SDK's
 * smallest browser build (@sentry/browser 11, default integrations off) is
 * 32 KB gzipped plus a request; this is one inline script that adds about
 * 3.9 KB gzipped to a page (React repeats it in the page data) and runs
 * nothing until an error, and the server side has no dependencies at all.
 *
 * Privacy by construction (SPEC principle 7): an event is built from an
 * allowlist (error type, stack frames, a route pattern and a few enum tags).
 * There is no request, no user, no breadcrumbs, no headers, cookies or
 * bodies, no source lines and no tracing. An error's message is withheld
 * unless it has a shape known to carry no customer data (a JavaScript
 * runtime error, a network failure, a database error that names only our
 * own schema, the text of one of our SQL queries); even then it is scrubbed
 * of emails, tokens, keys, query strings, IP addresses and home directories.
 * Messages are free text: a failed clone quotes the repository and a missing
 * file its path, so nothing is sent in the hope that a scrubber catches it.
 *
 * Shared by the server reporter and the browser snippet, so both apply the
 * same rules.
 */

export interface Dsn {
  /** Where envelopes go, with the public key in the query (no auth header, no CORS preflight). */
  endpoint: string;
  dsn: string;
}

/** Parses `https://<key>@<host>[/<path>]/<project>`. Undefined for anything else, so a bad value turns reporting off. */
export function parseDsn(value: string | undefined): Dsn | undefined {
  if (!value) return undefined;
  // A malformed DSN must turn reporting off, never throw: callers run inside error handlers and page renders.
  try {
    const url = new URL(value);
    const match = /^(.*)\/(\d+)\/?$/.exec(url.pathname);
    if (!url.username || !match || !/^https?:$/.test(url.protocol)) return undefined;
    const key = encodeURIComponent(decodeURIComponent(url.username));
    return { endpoint: `${url.protocol}//${url.host}${match[1]}/api/${match[2]}/envelope/?sentry_version=7&sentry_key=${key}&sentry_client=sandchest%2F1`, dsn: value };
  } catch {
    return undefined;
  }
}

/** The longest message kept, after scrubbing. Input is cut to four times this before anything else runs. */
export const MAX_MESSAGE = 1_000;

/**
 * Scrub rules as [pattern, flags, replacement]. Strings, not RegExps, so the
 * browser snippet can carry the same list. Every rule either starts at a
 * fixed literal or at the beginning of a run, so a long input costs one pass
 * per rule. The broad token rule runs last.
 */
export const SCRUB_RULES: ReadonlyArray<readonly [string, string, string]> = [
  // Drizzle quotes a failed query's parameters, which can be anything a user typed.
  ["params:[\\s\\S]*", "g", "params: [redacted]"],
  // Postgres "Key (email)=(…)" details quote values too.
  ["\\)=\\([^)]*\\)", "g", ")=([redacted])"],
  ["-----BEGIN [A-Z ]+-----[\\s\\S]*?-----END [A-Z ]+-----", "g", "[key]"],
  ["\\b(Bearer|Basic|token)\\s+[A-Za-z0-9._~+/=-]{8,}", "gi", "$1 [redacted]"],
  ["\\b(gh[pousr]_|github_pat_|sk-|xox[abpr]-)[A-Za-z0-9_-]+", "g", "[token]"],
  ["\\beyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+", "g", "[token]"],
  ["(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\\.[A-Za-z]{2,24}", "g", "[email]"],
  ["(https?:\\/\\/[^\\s?#\"'<>]+)[?#][^\\s\"'<>]*", "g", "$1?[query]"],
  ["\\b\\d{1,3}(\\.\\d{1,3}){3}\\b", "g", "[ip]"],
  ["([\\\\/](?:Users|home)[\\\\/])[^\\\\/\\s]+", "gi", "$1[user]"],
  // Long secret-looking runs (letters and digits mixed). UUIDs are opaque ids and stay.
  ["(?<![A-Za-z0-9+/=_-])(?![0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-z]))(?=[A-Za-z0-9+/=_-]*\\d)(?=[A-Za-z0-9+/=_-]*[A-Za-z])[A-Za-z0-9+/=_-]{24,}", "g", "[redacted]"],
];

const RULES = SCRUB_RULES.map(([pattern, flags, replacement]) => [new RegExp(pattern, flags), replacement] as const);

/** Scrubs text for a report. Long input is cut first, so scrubbing time stays bounded. */
export function scrub(text: unknown): string {
  let value = (typeof text === "string" ? text : String(text ?? "")).slice(0, MAX_MESSAGE * 4);
  for (const [pattern, replacement] of RULES) value = value.replace(pattern, replacement);
  return value.length > MAX_MESSAGE ? `${value.slice(0, MAX_MESSAGE)}…` : value;
}

/**
 * Error messages that may be sent, as [pattern, flags, what to send]: shapes
 * that carry no customer data. What is sent is static text, plus groups that
 * can only hold code identifiers, enum words, our own schema names or our own
 * SQL. Hosts, addresses, ports, database and role names are never kept, even
 * when the shape is known. Every other message is withheld. Quantifiers are
 * bounded, so no message makes matching slow.
 */
export const SAFE_MESSAGES: ReadonlyArray<readonly [string, string, string]> = [
  // JavaScript runtime errors name code, not data. Only identifier characters pass.
  // Property and variable names are replaced too: code can name things after data ("reading 'AcmeCorp'").
  ["^Cannot read properties of (undefined|null) \\(reading '[^'\\n]{1,200}'\\)$", "", "Cannot read properties of $1 (reading <property>)"],
  ["^Cannot (read|set) property '[^'\\n]{1,200}' of (undefined|null)$", "", "Cannot $1 property <property> of $2"],
  ["^[\\w$.]{1,120} is not (a function|defined|iterable|a constructor)$", "", "<expression> is not $1"],
  ["^(undefined|null) is not an object \\(evaluating '[^'\\n]{1,120}'\\)$", "", "$1 is not an object"],
  ["^Maximum call stack size exceeded$", "", "Maximum call stack size exceeded"],
  ["^Unexpected end of JSON input$", "", "Unexpected end of JSON input"],
  ["^Minified React error #(\\d{1,4})", "", "Minified React error #$1"],
  ["^Hydration failed because", "", "Hydration failed"],
  // Network failures and timeouts: the error code only, never the host, address or port.
  ["^(Failed to fetch|Load failed|fetch failed|NetworkError when attempting to fetch resource\\.|The operation was aborted\\.|This operation was aborted|The user aborted a request\\.|The operation timed out\\.|The operation was aborted due to timeout)$", "", "$1"],
  ["^(connect|read|write) (ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH)\\b", "", "$1 $2"],
  ["^getaddrinfo (ENOTFOUND|EAI_AGAIN)\\b", "", "getaddrinfo $1"],
  // Postgres: our own SQL (its parameters are cut) and our own schema names pass; database and role names do not.
  ["^Failed query: [^\\n]{1,600}", "", "$&"],
  ['^duplicate key value violates unique constraint "([\\w.]{1,63})"$', "", 'duplicate key value violates unique constraint "$1"'],
  ['^(relation|column|function|schema) "([\\w.$]{1,120})" does not exist$', "", '$1 "$2" does not exist'],
  ['^(database|role) "[^"\\n]{1,120}" does not exist$', "", "$1 does not exist"],
  ["^password authentication failed for user\\b", "", "password authentication failed"],
  ["^too many connections for role\\b", "", "too many connections for role"],
  ["^(canceling statement due to (?:statement timeout|user request)|deadlock detected|Connection terminated unexpectedly|Connection terminated|sorry, too many clients already)$", "", "$1"],
  // Our own messages: an opaque id, or only that the configuration is wrong.
  ["^Scan ([0-9a-f-]{36}) not found$", "", "Scan $1 not found"],
  ["^Invalid server configuration:", "", "Invalid server configuration"],
];

const SAFE = SAFE_MESSAGES.map(([pattern, flags, output]) => [new RegExp(pattern, flags), output] as const);

/** Sent in place of a message without a known-safe shape. */
export const WITHHELD = "(message withheld)";

/** The message to send: the known-safe text its shape allows, scrubbed, or a placeholder. */
export function safeMessage(message: unknown): string {
  const text = (typeof message === "string" ? message : "").slice(0, MAX_MESSAGE * 4);
  for (const [pattern, output] of SAFE) {
    const match = pattern.exec(text);
    if (match) return scrub(match[0].replace(pattern, output));
  }
  return WITHHELD;
}

/**
 * The page an error happened on, as one of the app's own route templates, or
 * "unknown". A raw path can hold anything a visitor typed, an email included.
 * Operator pages are deliberately absent: naming them here would put them in
 * every page.
 */
export const PAGE_TEMPLATES: ReadonlyArray<readonly [string, string]> = [
  ["^/$", "/"],
  ["^/dashboard$", "/dashboard"],
  ["^/dashboard/findings$", "/dashboard/findings"],
  ["^/dashboard/findings/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", "/dashboard/findings/[id]"],
  ["^/dashboard/scans$", "/dashboard/scans"],
  ["^/dashboard/repos$", "/dashboard/repos"],
  ["^/dashboard/repos/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", "/dashboard/repos/[id]"],
  ["^/dashboard/scans/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", "/dashboard/scans/[id]"],
  ["^/dashboard/settings$", "/dashboard/settings"],
  ["^/dashboard/billing/confirm$", "/dashboard/billing/confirm"],
  ["^/dashboard/billing/return$", "/dashboard/billing/return"],
  ["^/sign-in$", "/sign-in"],
];

const PAGES = PAGE_TEMPLATES.map(([pattern, template]) => [new RegExp(pattern), template] as const);

export function pageTemplate(pathname: string): string {
  for (const [pattern, template] of PAGES) if (pattern.test(pathname)) return template;
  return "unknown";
}

/**
 * Error types that may be sent: JavaScript's own, ours, and the database
 * driver's. A class name is code, but code can be generated or named after
 * data, so any other name is sent as "Error".
 */
export const ERROR_TYPES: readonly string[] = [
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
  "DOMException",
  "NotFoundError",
  "SecurityError",
  "QuotaExceededError",
  "ChunkLoadError",
  "AutumnError",
  "GitHubError",
  "IndexerError",
  "LlmError",
  "LlmQuotaError",
  "ManifestError",
  "ScanFinished",
  "ScanRefusedError",
  "StructuredOutputError",
  "WorkspaceError",
  "PostgresError",
  "DrizzleError",
  "DrizzleQueryError",
];

const KNOWN_TYPES = new Set(ERROR_TYPES);

export function errorType(name: unknown): string {
  return typeof name === "string" && KNOWN_TYPES.has(name) ? name : "Error";
}

/** A stack frame: where, never what. Function names are left out: they can be named after data, and file, line and column with source maps say the same. */
export interface Frame {
  filename: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
}

const V8 = /^\s*at (?:async )?(?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/;
const GECKO = /^\s*(.*?)@(.+?):(\d+):(\d+)\s*$/;

/**
 * Stack frames, oldest call first as Sentry wants them. Only our own code's
 * files are kept, by a fixed shape: on the server the build or package path
 * (never the directory above it), in the browser (`origin` given) our own
 * `/_next/static/` assets. Any other frame is dropped: its file name could
 * be a page URL, an extension or a path with a person's name in it.
 */
export function parseStack(stack: string | undefined, origin?: string): Frame[] {
  if (!stack) return [];
  const frames: Frame[] = [];
  for (const line of stack.split("\n", 60)) {
    // Frames are short; a long line is part of a message, never worth a regex pass.
    if (line.length > 1_000) continue;
    const match = V8.exec(line) ?? GECKO.exec(line);
    if (!match) continue;
    const filename = ownFile(match[2]!, origin);
    if (!filename) continue;
    frames.push({
      filename,
      lineno: Number(match[3]),
      colno: Number(match[4]),
      in_app: !/node_modules|^node:|^internal\/|^<anonymous>/.test(filename),
    });
  }
  return frames.reverse();
}

// Bundler chunk names can carry brackets ("[turbopack]_runtime.js"), encoded in URLs.
const STATIC_ASSET = /^\/_next\/static\/[\w./%[\]-]{1,200}$/;
const SERVER_FILE = /\/(?:\.next|node_modules|src)\/[\w./@+[\]-]{1,300}$/;
const RUNTIME_FILE = /^(?:node:[\w/]{1,100}|internal\/[\w/.]{1,100}|<anonymous>|native)$/;

function ownFile(file: string, origin?: string): string | undefined {
  const bare = file.replace(/^file:\/\//, "").split(/[?#]/)[0]!;
  if (origin !== undefined) {
    const path = bare.startsWith(`${origin}/`) ? bare.slice(origin.length) : undefined;
    return path && STATIC_ASSET.test(path) ? `app://${path}` : undefined;
  }
  if (RUNTIME_FILE.test(bare)) return bare;
  const local = bare.startsWith("/") ? SERVER_FILE.exec(bare) : null;
  return local ? `app://${local[0]}` : undefined;
}

export interface ExceptionValue {
  type: string;
  value: string;
  stacktrace?: { frames: Frame[] };
  mechanism: { type: string; handled: boolean };
}

/** An error and up to two causes, innermost first (Sentry's order). Non-errors are reported by type only. */
export function exceptionValues(error: unknown, mechanism: { type: string; handled: boolean }, origin?: string): ExceptionValue[] {
  const values: ExceptionValue[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current !== undefined && current !== null; depth++) {
    if (current instanceof Error) {
      const frames = parseStack(current.stack, origin);
      values.push({ type: errorType(current.name), value: safeMessage(current.message), ...(frames.length ? { stacktrace: { frames } } : {}), mechanism });
      current = (current as { cause?: unknown }).cause;
    } else {
      // A thrown string or object could hold anything: keep only what kind of value it was.
      values.push({ type: "NonError", value: `Non-error value thrown: ${typeof current}`, mechanism });
      break;
    }
  }
  return values.reverse();
}

export interface SentryEvent {
  event_id: string;
  timestamp: number;
  platform: "node" | "javascript";
  level: "error" | "warning";
  environment?: string;
  release?: string;
  exception: { values: ExceptionValue[] };
  tags: Record<string, string>;
  sdk: { name: string; version: string };
}

/** Tag values are short enums and patterns; anything else is cut and scrubbed. */
export function cleanTags(tags: Record<string, string | number | boolean | undefined>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) if (value !== undefined && value !== "") clean[key.slice(0, 32)] = scrub(String(value)).slice(0, 200);
  return clean;
}

/** The envelope: a header line, an item header line and the event. */
export function envelope(event: SentryEvent, dsn: Dsn, now = new Date()): string {
  return `${JSON.stringify({ event_id: event.event_id, sent_at: now.toISOString(), dsn: dsn.dsn })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}\n`;
}

/** A signature for de-duplicating repeats of the same error. */
export function signature(values: ExceptionValue[]): string {
  const last = values.at(-1);
  const frame = last?.stacktrace?.frames.at(-1);
  return `${last?.type}:${last?.value.slice(0, 120)}:${frame?.filename}:${frame?.lineno}`;
}
