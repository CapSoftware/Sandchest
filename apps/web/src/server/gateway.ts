/**
 * The model gateway: the one way an agent inside a scan's sandbox reaches a
 * model. The sandbox holds a short-lived token scoped to its scan, never a
 * provider key. Every call is checked against the scan's spending ceiling
 * before it is forwarded and written to the usage ledger when it ends, so
 * the ledger holds what the scan really spent.
 *
 * It speaks the messages format the agent CLI sends (`POST /v1/messages`,
 * streamed as server-sent events) and forwards to the configured endpoint
 * with the configured model, whatever model the caller named.
 *
 * Where it cannot tell what a call cost, it stops the scan's calls instead of
 * carrying on unmetered:
 * - a call that finished with no cost reported (`unpriced`), or one whose
 *   outcome was never recorded (`started` for too long), refuses every later
 *   call of that scan;
 * - calls that broke off before a cost arrived (`aborted`) are tolerated up to
 *   `MAX_ABORTED_UNPRICED` per scan, then refused the same way.
 *
 * The ceiling is checked against what is already recorded, so calls under way
 * are not counted: it can be passed by at most what `MAX_IN_FLIGHT` calls cost.
 *
 * Pure: settings, the database and the network are all passed in.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { usdToMicroUsd } from "@sandchest/billing/usage";
import type { UsageBudgetState, UsageCallResult } from "@sandchest/db";
import { z } from "zod";

// ---- Token ------------------------------------------------------------------

/** What a gateway token says. Signed, so the sandbox cannot change any of it. */
export interface GatewayClaims {
  scanId: string;
  /** Ledger stage of the calls made with it: `verify`, `variants`... */
  stage: string;
  /** Which run of the step handed the token out. */
  attempt: number;
  /** The scan's spending ceiling, in micro-dollars of cost. */
  ceilingMicroUsd: number;
  /** Unix seconds. */
  expiresAt: number;
  /** Calls go to the fast endpoint. Absent means the standard one, as in every token minted before it existed. */
  fast?: true;
}

const TOKEN_PREFIX = "sgw1";
const MIN_SECRET_LENGTH = 32;
/** A token outlives no scan: credits are held for six hours. */
export const MAX_TOKEN_TTL_SECONDS = 6 * 60 * 60;
const STAGE = /^[a-z][a-z0-9_]{0,31}$/;

const ClaimsSchema = z.object({
  s: z.uuid(),
  t: z.string().regex(STAGE),
  a: z.number().int().min(0).max(1_000_000),
  c: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  e: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  f: z.literal(true).optional(),
});

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(`${TOKEN_PREFIX}.${body}`).digest("base64url");
}

/** A token for one scan's agent. Throws on claims a token must not carry, or a secret too short to sign with. */
export function mintGatewayToken(claims: Omit<GatewayClaims, "expiresAt"> & { ttlSeconds: number }, secret: string, now: number = Date.now()): string {
  if (secret.length < MIN_SECRET_LENGTH) throw new Error("The gateway secret is too short");
  if (!Number.isInteger(claims.ttlSeconds) || claims.ttlSeconds < 1 || claims.ttlSeconds > MAX_TOKEN_TTL_SECONDS) throw new RangeError(`A gateway token lasts 1 to ${MAX_TOKEN_TTL_SECONDS} seconds`);
  const payload = ClaimsSchema.parse({ s: claims.scanId, t: claims.stage, a: claims.attempt, c: claims.ceilingMicroUsd, e: Math.floor(now / 1000) + claims.ttlSeconds, ...(claims.fast && { f: true }) });
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${TOKEN_PREFIX}.${body}.${sign(body, secret)}`;
}

/** The claims of a token this secret signed and that has not expired; undefined for anything else. */
export function verifyGatewayToken(token: string, secret: string, now: number = Date.now()): GatewayClaims | undefined {
  if (secret.length < MIN_SECRET_LENGTH || token.length > 1024) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return undefined;
  const given = Buffer.from(parts[2]!);
  const expected = Buffer.from(sign(parts[1]!, secret));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  const parsed = ClaimsSchema.safeParse(payload);
  if (!parsed.success || parsed.data.e * 1000 <= now) return undefined;
  return { scanId: parsed.data.s, stage: parsed.data.t, attempt: parsed.data.a, ceilingMicroUsd: parsed.data.c, expiresAt: parsed.data.e, ...(parsed.data.f && { fast: true as const }) };
}

/** Where a sandbox's agent sends its model calls, and the one host it therefore has to reach. */
export function gatewayEndpoint(appUrl: string): { baseUrl: string; host: string } {
  const url = new URL(appUrl);
  return { baseUrl: `${url.origin}/api/gateway`, host: url.hostname };
}

// ---- Upstream ---------------------------------------------------------------

export interface GatewayUpstream {
  /** Base URL including the version segment. No trailing slash. */
  baseUrl: string;
  apiKey: string;
  /** The model every forwarded call runs on. */
  model: string;
  /** Fields set on every forwarded request (endpoint options such as asking for the cost to be reported). */
  body: Readonly<Record<string, unknown>>;
}

const optionalText = z.string().trim().min(1).optional();
const UpstreamSchema = z.object({
  LLM_AGENT_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
  LLM_AGENT_API_KEY: optionalText,
  LLM_AGENT_MODEL: optionalText,
  LLM_AGENT_BODY: optionalText,
  LLM_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
  LLM_API_KEY: optionalText,
  LLM_MODEL: optionalText,
});

/** The parts of a request that are the caller's alone. `LLM_AGENT_BODY` may not set them. */
const CALLER_FIELDS = ["model", "messages", "system", "tools", "tool_choice", "stream"];

/**
 * Reads where the gateway forwards to: `LLM_AGENT_BASE_URL`, `LLM_AGENT_API_KEY` and `LLM_AGENT_MODEL`,
 * each falling back to the engine's `LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL`, plus the optional
 * `LLM_AGENT_BODY` (a JSON object). Throws one error naming every problem.
 */
export function loadGatewayUpstream(env: Record<string, string | undefined> = process.env): GatewayUpstream {
  const parsed = UpstreamSchema.safeParse(Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value.trim() !== "")));
  const problems = parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  const data = parsed.success ? parsed.data : {};
  const baseUrl = data.LLM_AGENT_BASE_URL ?? data.LLM_BASE_URL;
  const apiKey = data.LLM_AGENT_API_KEY ?? data.LLM_API_KEY;
  const model = data.LLM_AGENT_MODEL ?? data.LLM_MODEL;
  if (parsed.success) {
    if (!baseUrl) problems.push("LLM_AGENT_BASE_URL or LLM_BASE_URL: is required");
    if (!apiKey) problems.push("LLM_AGENT_API_KEY or LLM_API_KEY: is required");
    if (!model) problems.push("LLM_AGENT_MODEL or LLM_MODEL: is required");
  }
  const body = upstreamBody("LLM_AGENT_BODY", data.LLM_AGENT_BODY, problems);
  if (problems.length > 0) throw new Error(`Invalid gateway configuration:\n  ${problems.join("\n  ")}`);
  return { baseUrl: baseUrl!.replace(/\/+$/, ""), apiKey: apiKey!, model: model!, body };
}

const FastUpstreamSchema = UpstreamSchema.extend({
  LLM_AGENT_FAST_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
  LLM_AGENT_FAST_API_KEY: optionalText,
  LLM_AGENT_FAST_MODEL: optionalText,
  LLM_AGENT_FAST_BODY: optionalText,
});

/**
 * Where the gateway forwards a fast run's calls: `LLM_AGENT_FAST_BASE_URL`, `LLM_AGENT_FAST_API_KEY` and
 * `LLM_AGENT_FAST_MODEL`, each falling back as `loadGatewayUpstream` does. The body is `LLM_AGENT_FAST_BODY`
 * alone, never the standard one: it is what picks the serving. With neither the fast model nor the fast body
 * set, nothing would differ from a standard call, so that is an error too. Throws one error naming every problem.
 */
export function loadFastGatewayUpstream(env: Record<string, string | undefined> = process.env): GatewayUpstream {
  const parsed = FastUpstreamSchema.safeParse(Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value.trim() !== "")));
  const problems = parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  const data = parsed.success ? parsed.data : {};
  const baseUrl = data.LLM_AGENT_FAST_BASE_URL ?? data.LLM_AGENT_BASE_URL ?? data.LLM_BASE_URL;
  const apiKey = data.LLM_AGENT_FAST_API_KEY ?? data.LLM_AGENT_API_KEY ?? data.LLM_API_KEY;
  const model = data.LLM_AGENT_FAST_MODEL ?? data.LLM_AGENT_MODEL ?? data.LLM_MODEL;
  if (parsed.success) {
    if (!baseUrl) problems.push("LLM_AGENT_FAST_BASE_URL, LLM_AGENT_BASE_URL or LLM_BASE_URL: is required");
    if (!apiKey) problems.push("LLM_AGENT_FAST_API_KEY, LLM_AGENT_API_KEY or LLM_API_KEY: is required");
    if (!model) problems.push("LLM_AGENT_FAST_MODEL, LLM_AGENT_MODEL or LLM_MODEL: is required");
    if (!data.LLM_AGENT_FAST_MODEL && !data.LLM_AGENT_FAST_BODY) problems.push("LLM_AGENT_FAST_MODEL or LLM_AGENT_FAST_BODY: is required for fast runs");
  }
  const body = upstreamBody("LLM_AGENT_FAST_BODY", data.LLM_AGENT_FAST_BODY, problems);
  if (problems.length > 0) throw new Error(`Invalid gateway configuration:\n  ${problems.join("\n  ")}`);
  return { baseUrl: baseUrl!.replace(/\/+$/, ""), apiKey: apiKey!, model: model!, body };
}

/** A body setting as an object (empty when unset). A problem with it is added to `problems`. */
function upstreamBody(name: string, text: string | undefined, problems: string[]): Record<string, unknown> {
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) problems.push(`${name}: must be a JSON object`);
    else if (CALLER_FIELDS.some((field) => field in value)) problems.push(`${name}: must not set ${CALLER_FIELDS.join(", ")}`);
    else return value;
  } catch {
    problems.push(`${name}: must be a JSON object`);
  }
  return {};
}

// ---- Request ----------------------------------------------------------------

/** Larger than any context the agent can send, smaller than anything that could exhaust the function. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Calls of one scan under way at once. More are asked to retry. */
export const MAX_IN_FLIGHT = 32;
/** Calls of one scan that may break off with no cost reported before its calls are refused. */
export const MAX_ABORTED_UNPRICED = 5;
/** A `started` row older than this is a call whose outcome was lost. Longer than any call may take. */
export const STALE_CALL_SECONDS = 15 * 60;
/** Longest one forwarded call may take, headers to last byte. Under the route's own limit, so the call is always recorded. */
export const UPSTREAM_TIMEOUT_MS = 540_000;
const CONNECT_ATTEMPTS = 3;
const RECORD_ATTEMPTS = 4;

/**
 * The request fields that are forwarded. Everything else is dropped: endpoints take options beyond the
 * messages format (search, routing, other models) that an agent reading untrusted code must not reach.
 */
const FORWARDED_FIELDS = ["messages", "system", "tools", "tool_choice", "max_tokens", "stream", "temperature", "top_p", "top_k", "stop_sequences", "thinking", "output_config"];

export interface GatewayDeps {
  /** Signs tokens. Undefined means the gateway is off: every request gets 404. */
  secret: string | undefined;
  /** Where calls go, from the verified token alone. Called once per request; a throw is a misconfigured gateway (503). */
  upstream: (claims: GatewayClaims) => GatewayUpstream;
  fetch: typeof fetch;
  budget: (scanId: string) => Promise<UsageBudgetState | undefined>;
  /** Opens the call's ledger row. */
  start: (scanId: string, call: { stage: string; role: string; attempt: number }) => Promise<number>;
  /** Closes it. */
  finish: (id: number, result: UsageCallResult) => Promise<boolean>;
  /** Keeps the function alive until `work` settles, after the response has gone. */
  keepAlive: (work: Promise<unknown>) => void;
  /** An error worth an operator's attention. `what` is a fixed phrase, never request content. */
  report: (error: unknown, what: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** For tests. Default `UPSTREAM_TIMEOUT_MS`. */
  upstreamTimeoutMs?: number;
}

type ErrorType = "authentication_error" | "permission_error" | "invalid_request_error" | "request_too_large" | "billing_error" | "rate_limit_error" | "api_error" | "not_found_error";

function refuse(status: number, type: ErrorType, message: string, headers?: Record<string, string>): Response {
  return Response.json({ type: "error", error: { type, message } }, { status, headers });
}

/** Handles `POST /v1/messages` from a sandbox. Never throws. */
export async function handleGatewayRequest(request: Request, deps: GatewayDeps): Promise<Response> {
  if (!deps.secret) return refuse(404, "not_found_error", "Not found");
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const authorization = request.headers.get("authorization") ?? "";
  const claims = authorization.startsWith("Bearer ") ? verifyGatewayToken(authorization.slice(7).trim(), deps.secret, now()) : undefined;
  if (!claims) return refuse(401, "authentication_error", "Invalid or expired token");

  let upstream: GatewayUpstream;
  try {
    upstream = deps.upstream(claims);
  } catch (error) {
    deps.report(error, "gateway configuration");
    return refuse(503, "api_error", "The gateway is not configured");
  }

  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return refuse(413, "request_too_large", "Request too large");
  let text: string;
  try {
    text = await request.text();
  } catch {
    return refuse(400, "invalid_request_error", "The request body could not be read");
  }
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) return refuse(413, "request_too_large", "Request too large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (!isRecord(body) || !Array.isArray(body.messages)) return refuse(400, "invalid_request_error", "Expected a JSON object with messages");

  // The scan must be running and under its ceiling, with nothing in its ledger whose cost is unknown.
  let budget: UsageBudgetState | undefined;
  try {
    budget = await deps.budget(claims.scanId);
  } catch (error) {
    deps.report(error, "gateway budget read");
    return refuse(503, "api_error", "The gateway could not check the scan's budget", { "retry-after": "2" });
  }
  if (!budget || budget.scanStatus !== "running") return refuse(403, "permission_error", "This scan is not running");
  let spent: number;
  try {
    spent = usdToMicroUsd(budget.spentUsd);
  } catch (error) {
    deps.report(error, "gateway budget read");
    return refuse(503, "api_error", "The gateway could not check the scan's budget");
  }
  if (spent >= claims.ceilingMicroUsd) return refuse(402, "billing_error", "This scan has reached its spending ceiling");
  if (budget.unpriced > 0 || budget.lost > 0 || budget.abortedUnpriced > MAX_ABORTED_UNPRICED) {
    return refuse(402, "billing_error", "This scan made calls whose cost is unknown, so it may make no more");
  }
  if (budget.inFlight >= MAX_IN_FLIGHT) return refuse(429, "rate_limit_error", "Too many calls at once for this scan", { "retry-after": "2" });

  let id: number;
  try {
    id = await deps.start(claims.scanId, { stage: claims.stage, role: "agent", attempt: claims.attempt });
  } catch (error) {
    deps.report(error, "gateway ledger write");
    return refuse(503, "api_error", "The gateway could not record the call", { "retry-after": "2" });
  }

  /** Closes the ledger row, trying again when the write fails. Never throws: a row left open stops the scan's later calls. */
  const record = async (result: UsageCallResult): Promise<void> => {
    for (let attempt = 1; ; attempt++) {
      try {
        await deps.finish(id, result);
        return;
      } catch (error) {
        if (attempt >= RECORD_ATTEMPTS) {
          deps.report(error, "gateway ledger write");
          return;
        }
        await sleep(100 * 4 ** (attempt - 1));
      }
    }
  };

  const streaming = body.stream === true;
  const forwarded = JSON.stringify(forwardedBody(body, upstream));
  const timeout = AbortSignal.timeout(deps.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS);
  let response: Response | undefined;
  for (let attempt = 1; !response; attempt++) {
    try {
      response = await deps.fetch(`${upstream.baseUrl}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: streaming ? "text/event-stream" : "application/json", authorization: `Bearer ${upstream.apiKey}` },
        body: forwarded,
        signal: timeout,
      });
    } catch (error) {
      if (attempt >= CONNECT_ATTEMPTS || timeout.aborted) {
        // No answer at all. It may still have been billed, so it counts as broken off, not as refused.
        await record({ status: "aborted", costUsd: 0 });
        deps.report(error, "gateway upstream request");
        return refuse(502, "api_error", "The model endpoint could not be reached");
      }
      await sleep(500 * 3 ** (attempt - 1));
    }
  }

  // Our key refused or our account out of funds: nothing the caller can fix.
  if ([401, 402, 403].includes(response.status)) deps.report(new Error(`The model endpoint answered ${response.status}`), "gateway upstream request");

  if (!response.ok || !streaming || !response.body) {
    let answer = "";
    let broken = false;
    try {
      answer = await response.text();
    } catch {
      broken = true;
    }
    const meter = new UsageMeter();
    try {
      meter.read(JSON.parse(answer));
    } catch {
      // Not JSON: nothing to meter.
    }
    const usage = meter.usage();
    const status = !response.ok ? "failed" : usage.costUsd !== undefined ? "ok" : broken ? "aborted" : "unpriced";
    await record({ status, ...usage.tokens, costUsd: usage.costUsd ?? 0 });
    if (status === "unpriced") deps.report(new Error("A model call finished with no cost reported"), "gateway unpriced call");
    if (broken) return refuse(502, "api_error", "The model endpoint's answer broke off");
    const headers: Record<string, string> = { "content-type": response.headers.get("content-type") ?? "application/json" };
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) headers["retry-after"] = retryAfter;
    return new Response(answer, { status: response.status, headers });
  }

  // Streamed: bytes go to the caller as they arrive, unchanged, and a copy is read for the usage. A caller
  // that leaves early does not stop the read: the call is still being paid for, so its cost is still wanted.
  const reader = response.body.getReader();
  const meter = new UsageMeter();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let gone = false;
  const out = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      gone = true;
    },
  });
  const work = (async () => {
    let broken = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        meter.push(value);
        if (!gone) {
          try {
            controller.enqueue(value);
          } catch {
            gone = true;
          }
        }
      }
    } catch {
      broken = true;
    }
    meter.end();
    const usage = meter.usage();
    const whole = !broken && meter.finished && !meter.failed;
    const status = whole ? (usage.costUsd !== undefined ? "ok" : "unpriced") : "aborted";
    await record({ status, ...usage.tokens, costUsd: usage.costUsd ?? 0 });
    if (status === "unpriced") deps.report(new Error("A model call finished with no cost reported"), "gateway unpriced call");
    if (gone) return;
    try {
      if (broken) controller.error(new Error("The model endpoint's stream broke off"));
      else controller.close();
    } catch {
      // The caller left between the last chunk and the close.
    }
  })();
  deps.keepAlive(work);
  return new Response(out, {
    status: 200,
    headers: { "content-type": response.headers.get("content-type") ?? "text/event-stream", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" },
  });
}

/** The caller's request as it is forwarded: known fields only, client-run tools only, our model and endpoint options. */
function forwardedBody(body: Record<string, unknown>, upstream: GatewayUpstream): Record<string, unknown> {
  const forwarded: Record<string, unknown> = {};
  for (const field of FORWARDED_FIELDS) if (body[field] !== undefined) forwarded[field] = body[field];
  // A tool with a type other than "custom" is run by the endpoint (search, fetch, code), not by the agent: never forwarded.
  if (Array.isArray(forwarded.tools)) forwarded.tools = forwarded.tools.filter((tool) => isRecord(tool) && (tool.type === undefined || tool.type === "custom"));
  return { ...forwarded, ...upstream.body, model: upstream.model };
}

// ---- Usage ------------------------------------------------------------------

/** Longest line of a stream that is still read for usage. A longer one is forwarded but not metered. */
const MAX_LINE_CHARS = 4 * 1024 * 1024;
/** No call has more tokens than this; a larger number is a broken response, and the ledger's columns are 32-bit. */
const MAX_TOKENS = 2_000_000_000;
const DECIMAL = /^\d{1,8}(\.\d{1,18})?$/;

/**
 * Collects a call's usage from a messages-format response: the `usage` of a whole (unstreamed) answer,
 * or of a stream's `message_start` and `message_delta` events. Later values replace earlier ones field
 * by field, as the format intends. The cost is the `cost` field of that usage, in USD.
 */
export class UsageMeter {
  private fields: Record<string, unknown> = {};
  private decoder = new TextDecoder();
  private buffer = "";
  private overflowed = false;
  /** The stream reached its last event. */
  finished = false;
  /** The stream carried an error event. */
  failed = false;

  /** One parsed event, or a whole answer. */
  read(event: unknown): void {
    if (!isRecord(event)) return;
    if (event.type === "error" || event.error !== undefined) this.failed = true;
    if (event.type === "message_stop") this.finished = true;
    if (isRecord(event.message) && isRecord(event.message.usage)) Object.assign(this.fields, event.message.usage);
    if (isRecord(event.usage)) Object.assign(this.fields, event.usage);
  }

  /** The next bytes of a stream. */
  push(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    for (let end = this.buffer.indexOf("\n"); end >= 0; end = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (this.overflowed) this.overflowed = false;
      else this.line(line);
    }
    if (this.buffer.length > MAX_LINE_CHARS) {
      this.buffer = "";
      this.overflowed = true;
    }
  }

  /** The stream is over: reads a last line that had no newline. */
  end(): void {
    this.buffer += this.decoder.decode();
    if (this.buffer && !this.overflowed) this.line(this.buffer);
    this.buffer = "";
  }

  private line(line: string): void {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    try {
      this.read(JSON.parse(data));
    } catch {
      // Not JSON: not an event we meter.
    }
  }

  usage(): { tokens: { inputTokens: number; cachedTokens: number; outputTokens: number; reasoningTokens: number }; costUsd: number | string | undefined } {
    const u = this.fields;
    const cached = count(u.cache_read_input_tokens);
    return {
      tokens: {
        // The format counts cached and cache-writing input apart from the rest; the ledger's input is all of it.
        inputTokens: Math.min(MAX_TOKENS, count(u.input_tokens) + cached + count(u.cache_creation_input_tokens)),
        cachedTokens: cached,
        outputTokens: count(u.output_tokens),
        reasoningTokens: 0,
      },
      costUsd: cost(u.cost),
    };
  }
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(MAX_TOKENS, Math.floor(value)) : 0;
}

/** A reported cost the ledger can hold exactly: a non-negative number, or a plain decimal string. */
function cost(value: unknown): number | string | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 && value < 1e8 ? value : undefined;
  if (typeof value === "string" && DECIMAL.test(value)) return value;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
