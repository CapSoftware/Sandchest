/**
 * The model gateway: tokens scoped to one scan, the spending ceiling checked before every call, and
 * every call written to the usage ledger with what it cost. The model endpoint is faked; the second
 * half runs against a real Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { createDb, createScan, finishUsageCall, insertUsage, scanUsageRows, startUsageCall, upsertInstallation, usageBudgetState, type Db, type UsageBudgetState, type UsageCallResult } from "@sandchest/db";
import { migrate } from "@sandchest/db/migrate";
import { POST as route } from "@/app/api/gateway/v1/messages/route";
import { resetConfig } from "@/server/config";
import {
  gatewayEndpoint,
  handleGatewayRequest,
  loadGatewayUpstream,
  MAX_ABORTED_UNPRICED,
  MAX_BODY_BYTES,
  MAX_IN_FLIGHT,
  MAX_TOKEN_TTL_SECONDS,
  mintGatewayToken,
  STALE_CALL_SECONDS,
  UsageMeter,
  verifyGatewayToken,
  type GatewayDeps,
  type GatewayUpstream,
} from "@/server/gateway";

const SECRET = "gateway-test-secret-0123456789abcdef";
const UPSTREAM_KEY = "upstream-key-never-leaves";
const SCAN = "2f0b7c1e-58a4-4f0e-9c55-0a6f2c7d9e11";
const NOW = 1_800_000_000_000;
const UPSTREAM: GatewayUpstream = { baseUrl: "https://models.test/v1", apiKey: UPSTREAM_KEY, model: "agent-model", body: { usage: { include: true } } };

const token = (overrides: Partial<Parameters<typeof mintGatewayToken>[0]> = {}, secret = SECRET, now = NOW) =>
  mintGatewayToken({ scanId: SCAN, stage: "verify", attempt: 2, ceilingMicroUsd: 300_000, ttlSeconds: 900, ...overrides }, secret, now);

// ---- A fake messages-format endpoint ----------------------------------------

const encoder = new TextEncoder();
const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const START = event("message_start", { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5, output_tokens: 1 } } });
const TEXT = event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "héllo ✓" } });
const delta = (usage: Record<string, unknown>) => event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage });
const STOP = event("message_stop", { type: "message_stop" });
const WHOLE = START + TEXT + delta({ output_tokens: 42, cost: 0.00123 }) + STOP;

/** A streamed answer, cut into chunks of `size` bytes so events and characters straddle chunks. */
function sse(text: string, size = 7): Response {
  const bytes = encoder.encode(text);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.slice(i, i + size));
  return new Response(new ReadableStream({ start: (c) => (chunks.forEach((chunk) => c.enqueue(chunk)), c.close()) }), { headers: { "content-type": "text/event-stream" } });
}

interface Harness {
  deps: GatewayDeps;
  state: UsageBudgetState;
  /** Requests the endpoint received. */
  sent: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }>;
  started: Array<{ scanId: string; stage: string; role: string; attempt: number }>;
  finished: Array<{ id: number } & UsageCallResult>;
  reports: string[];
  kept: Promise<unknown>[];
  calls: { budget: number };
}

function harness(answer: (attempt: number, signal: AbortSignal) => Response | Promise<Response> = () => sse(WHOLE), overrides: Partial<GatewayDeps> = {}): Harness {
  const h: Harness = {
    state: { scanStatus: "running", spentUsd: "0", inFlight: 0, lost: 0, unpriced: 0, abortedUnpriced: 0 },
    sent: [],
    started: [],
    finished: [],
    reports: [],
    kept: [],
    calls: { budget: 0 },
    deps: undefined as unknown as GatewayDeps,
  };
  h.deps = {
    secret: SECRET,
    upstream: () => UPSTREAM,
    fetch: (async (url: string, init: RequestInit) => {
      h.sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
      return answer(h.sent.length, init.signal as AbortSignal);
    }) as unknown as typeof fetch,
    budget: async () => (h.calls.budget++, h.state),
    start: async (scanId, call) => h.started.push({ scanId, ...call }),
    finish: async (id, result) => (h.finished.push({ id, ...result }), true),
    keepAlive: (work) => void h.kept.push(work),
    report: (_error, what) => void h.reports.push(what),
    now: () => NOW,
    sleep: async () => {},
    ...overrides,
  };
  return h;
}

const call = (body: unknown = { model: "whatever", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] }, headers: Record<string, string> = { authorization: `Bearer ${token()}` }) =>
  new Request("https://sandchest.test/api/gateway/v1/messages", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

async function settle(h: Harness, response: Response): Promise<string> {
  const text = await response.text().catch((error: Error) => `stream error: ${error.message}`);
  await Promise.all(h.kept);
  return text;
}

// ---- Tokens -----------------------------------------------------------------

describe("gateway tokens", () => {
  test("a token carries its scan, stage, attempt, ceiling and expiry", () => {
    expect(verifyGatewayToken(token(), SECRET, NOW)).toEqual({ scanId: SCAN, stage: "verify", attempt: 2, ceilingMicroUsd: 300_000, expiresAt: NOW / 1000 + 900 });
  });

  test("a token signed with another secret, or changed after signing, is refused", () => {
    expect(verifyGatewayToken(token({}, "another-secret-0123456789abcdef-xyz"), SECRET, NOW)).toBeUndefined();
    const [prefix, body, signature] = token().split(".") as [string, string, string];
    // The same claims with ten times the ceiling, under the original signature.
    const richer = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), c: 3_000_000 })).toString("base64url");
    expect(verifyGatewayToken(`${prefix}.${richer}.${signature}`, SECRET, NOW)).toBeUndefined();
    expect(verifyGatewayToken(`${prefix}.${body}.${signature.slice(0, -1)}`, SECRET, NOW)).toBeUndefined();
    expect(verifyGatewayToken(`${prefix}.${body}.${signature}`, SECRET, NOW)).toBeDefined();
  });

  test("a token stops working the second it expires", () => {
    const t = token({ ttlSeconds: 60 });
    expect(verifyGatewayToken(t, SECRET, NOW + 59_999)).toBeDefined();
    expect(verifyGatewayToken(t, SECRET, NOW + 60_000)).toBeUndefined();
  });

  test("anything that is not a token is refused, never thrown on", () => {
    for (const junk of ["", "sgw1", "sgw1..", "a.b.c", "sgw2.e30.x", `sgw1.${"A".repeat(2000)}.x`, "Bearer abc", "sgw1.e30.", "sgw1.!!!.???"]) expect(verifyGatewayToken(junk, SECRET, NOW)).toBeUndefined();
    // A valid signature over claims a token may not carry.
    expect(verifyGatewayToken(token(), "short", NOW)).toBeUndefined();
  });

  test("a token cannot be minted with a short secret, a long life, or claims out of range", () => {
    expect(() => token({}, "too-short")).toThrow("too short");
    expect(() => token({ ttlSeconds: MAX_TOKEN_TTL_SECONDS + 1 })).toThrow();
    expect(() => token({ ttlSeconds: 0 })).toThrow();
    expect(() => token({ ttlSeconds: 1.5 })).toThrow();
    expect(() => token({ scanId: "not-a-uuid" })).toThrow();
    expect(() => token({ stage: "Verify stage" })).toThrow();
    expect(() => token({ ceilingMicroUsd: 0 })).toThrow();
    expect(() => token({ ceilingMicroUsd: 0.5 })).toThrow();
    expect(() => token({ attempt: -1 })).toThrow();
    expect(token({ ttlSeconds: MAX_TOKEN_TTL_SECONDS })).toStartWith("sgw1.");
  });

  test("the sandbox is pointed at the app's own host", () => {
    expect(gatewayEndpoint("https://www.sandchest.test/")).toEqual({ baseUrl: "https://www.sandchest.test/api/gateway", host: "www.sandchest.test" });
    expect(gatewayEndpoint("http://localhost:3000")).toEqual({ baseUrl: "http://localhost:3000/api/gateway", host: "localhost" });
  });
});

// ---- Settings ---------------------------------------------------------------

describe("gateway upstream settings", () => {
  const engine = { LLM_BASE_URL: "https://engine.test/v1/", LLM_API_KEY: "engine-key", LLM_MODEL: "engine-model" };

  test("defaults to the engine's endpoint, key and model", () => {
    expect(loadGatewayUpstream(engine)).toEqual({ baseUrl: "https://engine.test/v1", apiKey: "engine-key", model: "engine-model", body: {} });
  });

  test("each agent setting replaces its default, and blanks count as unset", () => {
    expect(loadGatewayUpstream({ ...engine, LLM_AGENT_BASE_URL: "https://agent.test/v1", LLM_AGENT_API_KEY: " ", LLM_AGENT_MODEL: "agent-model", LLM_AGENT_BODY: '{"usage":{"include":true}}' })).toEqual({
      baseUrl: "https://agent.test/v1",
      apiKey: "engine-key",
      model: "agent-model",
      body: { usage: { include: true } },
    });
  });

  test("every problem is named in one error", () => {
    expect(() => loadGatewayUpstream({})).toThrow(/LLM_BASE_URL[\s\S]*LLM_API_KEY[\s\S]*LLM_MODEL/);
    expect(() => loadGatewayUpstream({ ...engine, LLM_AGENT_BASE_URL: "ftp://x" })).toThrow("LLM_AGENT_BASE_URL");
    for (const body of ["[1]", "nope", '"text"', "null"]) expect(() => loadGatewayUpstream({ ...engine, LLM_AGENT_BODY: body })).toThrow("LLM_AGENT_BODY: must be a JSON object");
  });

  test("the fixed request fields cannot take over the caller's conversation or model", () => {
    for (const field of ["model", "messages", "system", "tools", "tool_choice", "stream"]) expect(() => loadGatewayUpstream({ ...engine, LLM_AGENT_BODY: JSON.stringify({ [field]: "x" }) })).toThrow("must not set");
  });
});

// ---- Reading usage ----------------------------------------------------------

describe("UsageMeter", () => {
  test("input is everything sent, cached or not; later events replace earlier counts", () => {
    const meter = new UsageMeter();
    meter.push(encoder.encode(WHOLE));
    meter.end();
    expect(meter.usage()).toEqual({ tokens: { inputTokens: 105, cachedTokens: 90, outputTokens: 42, reasoningTokens: 0 }, costUsd: 0.00123 });
    expect(meter.finished).toBe(true);
    expect(meter.failed).toBe(false);
  });

  test("a whole answer is read the same way", () => {
    const meter = new UsageMeter();
    meter.read({ type: "message", usage: { input_tokens: 7, output_tokens: 3, cost: "0.0000004567" } });
    expect(meter.usage()).toEqual({ tokens: { inputTokens: 7, cachedTokens: 0, outputTokens: 3, reasoningTokens: 0 }, costUsd: "0.0000004567" });
  });

  test("only a cost the ledger can hold exactly counts as a cost", () => {
    const priced = (value: unknown) => {
      const meter = new UsageMeter();
      meter.read({ usage: { cost: value } });
      return meter.usage().costUsd;
    };
    expect(priced(0)).toBe(0);
    expect(priced(1.5)).toBe(1.5);
    expect(priced("12.5")).toBe("12.5");
    for (const bad of [-0.01, Number.NaN, Number.POSITIVE_INFINITY, 1e9, "1e-3", "-1", "", " 1", "abc", null, undefined, {}, true]) expect(priced(bad)).toBeUndefined();
  });

  test("token counts that make no sense are zero, never negative or fractional", () => {
    const meter = new UsageMeter();
    meter.read({ usage: { input_tokens: -5, cache_read_input_tokens: "90", cache_creation_input_tokens: 2.9, output_tokens: 1e12 } });
    expect(meter.usage().tokens).toEqual({ inputTokens: 2, cachedTokens: 0, outputTokens: 2_000_000_000, reasoningTokens: 0 });
  });

  test("lines that are not events, a last line without a newline, and an endless line", () => {
    const meter = new UsageMeter();
    meter.push(encoder.encode(": keep-alive\ndata: not json\ndata: [DONE]\nevent: ping\n"));
    meter.push(encoder.encode(`data: ${"x".repeat(5 * 1024 * 1024)}`));
    meter.push(encoder.encode(`tail of the endless line\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 9, cost: 0.5 } })}`));
    meter.end();
    expect(meter.usage()).toMatchObject({ tokens: { outputTokens: 9 }, costUsd: 0.5 });
    expect(meter.finished).toBe(false);
  });

  test("an error event marks the stream failed", () => {
    const meter = new UsageMeter();
    meter.push(encoder.encode(START + event("error", { type: "error", error: { type: "overloaded_error", message: "busy" } })));
    meter.end();
    expect(meter.failed).toBe(true);
  });
});

// ---- The handler ------------------------------------------------------------

describe("gateway: who may call", () => {
  test("off without a secret: 404 and nothing is touched", async () => {
    const h = harness(undefined, { secret: undefined });
    const response = await handleGatewayRequest(call(), h.deps);
    expect(response.status).toBe(404);
    expect([h.calls.budget, h.sent.length, h.started.length]).toEqual([0, 0, 0]);
  });

  test("no token, a bad token or an expired one: 401 before the database or the endpoint is touched", async () => {
    const h = harness();
    for (const headers of [{}, { authorization: "Bearer nope" }, { authorization: token() }, { authorization: `Basic ${token()}` }, { "x-api-key": token() }, { authorization: `Bearer ${token({ ttlSeconds: 60 }, SECRET, NOW - 61_000)}` }, { authorization: `Bearer ${token({}, "another-secret-0123456789abcdef-xyz")}` }]) {
      const response = await handleGatewayRequest(call(undefined, headers as Record<string, string>), h.deps);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ type: "error", error: { type: "authentication_error", message: "Invalid or expired token" } });
    }
    expect([h.calls.budget, h.sent.length, h.started.length]).toEqual([0, 0, 0]);
  });

  test("a scan that is gone or no longer running: 403, nothing forwarded", async () => {
    const h = harness();
    for (const status of ["queued", "publishing", "completed", "failed", "cancelled", "refused"] as const) {
      h.state.scanStatus = status;
      expect((await handleGatewayRequest(call(), h.deps)).status).toBe(403);
    }
    const none = harness(undefined, { budget: async () => undefined });
    expect((await handleGatewayRequest(call(), none.deps)).status).toBe(403);
    expect([h.sent.length, h.started.length, none.sent.length, none.started.length]).toEqual([0, 0, 0, 0]);
  });

  test("a misconfigured gateway answers 503 and says so to the operator, not the caller", async () => {
    const h = harness(undefined, {
      upstream: () => {
        throw new Error("Invalid gateway configuration: LLM_AGENT_API_KEY");
      },
    });
    const response = await handleGatewayRequest(call(), h.deps);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("LLM_AGENT_API_KEY");
    expect(h.reports).toEqual(["gateway configuration"]);
    expect(h.sent).toHaveLength(0);
  });

  test("a body that is not a messages request: 400; one too large: 413", async () => {
    const h = harness();
    for (const body of ["not json", "[]", "null", '{"messages":"hi"}', "{}"]) expect((await handleGatewayRequest(call(body), h.deps)).status).toBe(400);
    expect((await handleGatewayRequest(call(undefined, { authorization: `Bearer ${token()}`, "content-length": String(MAX_BODY_BYTES + 1) }), h.deps)).status).toBe(413);
    expect((await handleGatewayRequest(call({ messages: [], pad: "x".repeat(MAX_BODY_BYTES) }), h.deps)).status).toBe(413);
    expect([h.calls.budget, h.sent.length, h.started.length]).toEqual([0, 0, 0]);
  });
});

describe("gateway: the spending ceiling", () => {
  test("at the ceiling every call is refused with 402 and nothing is forwarded or recorded", async () => {
    const h = harness();
    h.state.spentUsd = "0.3000000000";
    const response = await handleGatewayRequest(call(), h.deps);
    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({ type: "error", error: { type: "billing_error", message: "This scan has reached its spending ceiling" } });
    h.state.spentUsd = "17.25";
    expect((await handleGatewayRequest(call(), h.deps)).status).toBe(402);
    expect([h.sent.length, h.started.length]).toEqual([0, 0]);
  });

  test("a micro-dollar under the ceiling still goes through", async () => {
    const h = harness();
    h.state.spentUsd = "0.2999990000";
    expect((await handleGatewayRequest(call(), h.deps)).status).toBe(200);
    // Half a micro-dollar rounds up to the ceiling.
    h.state.spentUsd = "0.2999995000";
    expect((await handleGatewayRequest(call(), h.deps)).status).toBe(402);
  });

  test("the ceiling is the token's, per scan", async () => {
    const h = harness();
    h.state.spentUsd = "0.05";
    expect((await handleGatewayRequest(call(undefined, { authorization: `Bearer ${token({ ceilingMicroUsd: 50_000 })}` }), h.deps)).status).toBe(402);
    expect((await handleGatewayRequest(call(undefined, { authorization: `Bearer ${token({ ceilingMicroUsd: 50_001 })}` }), h.deps)).status).toBe(200);
  });

  test("a call whose cost is unknown, or whose outcome was lost, stops every later call", async () => {
    for (const field of ["unpriced", "lost"] as const) {
      const h = harness();
      h.state[field] = 1;
      const response = await handleGatewayRequest(call(), h.deps);
      expect(response.status).toBe(402);
      expect(h.sent).toHaveLength(0);
    }
  });

  test("a few calls that broke off are tolerated, then the scan's calls stop", async () => {
    const h = harness();
    h.state.abortedUnpriced = MAX_ABORTED_UNPRICED;
    expect((await handleGatewayRequest(call(), h.deps)).status).toBe(200);
    h.state.abortedUnpriced = MAX_ABORTED_UNPRICED + 1;
    expect((await handleGatewayRequest(call(), h.deps)).status).toBe(402);
  });

  test("too many calls at once are asked to come back, not refused for good", async () => {
    const h = harness();
    h.state.inFlight = MAX_IN_FLIGHT;
    const response = await handleGatewayRequest(call(), h.deps);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("2");
    h.state.inFlight = MAX_IN_FLIGHT - 1;
    expect((await handleGatewayRequest(call(), h.deps)).status).toBe(200);
  });

  test("when the budget cannot be read, or the call cannot be recorded, nothing is forwarded", async () => {
    const unread = harness(undefined, {
      budget: async () => {
        throw new Error("db down");
      },
    });
    expect((await handleGatewayRequest(call(), unread.deps)).status).toBe(503);
    const unwritten = harness(undefined, {
      start: async () => {
        throw new Error("db down");
      },
    });
    expect((await handleGatewayRequest(call(), unwritten.deps)).status).toBe(503);
    const garbled = harness();
    garbled.state.spentUsd = "NaN";
    expect((await handleGatewayRequest(call(), garbled.deps)).status).toBe(503);
    expect([unread.sent.length, unwritten.sent.length, garbled.sent.length]).toEqual([0, 0, 0]);
    expect([...unread.reports, ...unwritten.reports, ...garbled.reports]).toEqual(["gateway budget read", "gateway ledger write", "gateway budget read"]);
  });
});

describe("gateway: what is forwarded", () => {
  test("our model, our key and our options; the caller's token, model and extra fields stay behind", async () => {
    const h = harness();
    const mine = token();
    const body = {
      model: "callers-choice",
      max_tokens: 4096,
      stream: true,
      system: [{ type: "text", text: "be strict" }],
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { name: "Read", description: "reads", input_schema: { type: "object" } },
        { type: "custom", name: "Grep", input_schema: { type: "object" } },
        { type: "web_search_v1", name: "web_search" },
        "junk",
      ],
      tool_choice: { type: "auto" },
      thinking: { type: "enabled", budget_tokens: 1024 },
      temperature: 1,
      metadata: { user_id: "device-and-account" },
      plugins: [{ id: "web" }],
      web_search_options: {},
      provider: { order: ["elsewhere"] },
      usage: { include: false },
    };
    const response = await handleGatewayRequest(call(body, { authorization: `Bearer ${mine}`, "x-beta": "x", "x-api-key": "y" }), h.deps);
    await settle(h, response);
    expect(h.sent).toHaveLength(1);
    const sent = h.sent[0]!;
    expect(sent.url).toBe("https://models.test/v1/messages");
    expect(sent.headers).toEqual({ "content-type": "application/json", accept: "text/event-stream", authorization: `Bearer ${UPSTREAM_KEY}` });
    expect(sent.body).toEqual({
      model: "agent-model",
      max_tokens: 4096,
      stream: true,
      system: body.system,
      messages: body.messages,
      tools: [body.tools[0], body.tools[1]],
      tool_choice: { type: "auto" },
      thinking: { type: "enabled", budget_tokens: 1024 },
      temperature: 1,
      usage: { include: true },
    });
    expect(JSON.stringify(sent)).not.toContain(mine);
  });

  test("the answer reaches the caller byte for byte, and never carries our key", async () => {
    for (const size of [1, 7, 64, 100_000]) {
      const h = harness(() => sse(WHOLE, size));
      const response = await handleGatewayRequest(call(), h.deps);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      const text = await settle(h, response);
      expect(text).toBe(WHOLE);
      expect(text).not.toContain(UPSTREAM_KEY);
    }
  });
});

describe("gateway: what is recorded", () => {
  test("a streamed call: one row for the token's scan, stage and attempt, closed with its tokens and cost", async () => {
    const h = harness();
    await settle(h, await handleGatewayRequest(call(), h.deps));
    expect(h.started).toEqual([{ scanId: SCAN, stage: "verify", role: "agent", attempt: 2 }]);
    expect(h.finished).toEqual([{ id: 1, status: "ok", inputTokens: 105, cachedTokens: 90, outputTokens: 42, reasoningTokens: 0, costUsd: 0.00123 }]);
    expect(h.reports).toEqual([]);
  });

  test("an unstreamed call", async () => {
    const answer = { type: "message", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 12, output_tokens: 4, cost: 0.000031 } };
    const h = harness(() => Response.json(answer));
    const response = await handleGatewayRequest(call({ messages: [{ role: "user", content: "hi" }], max_tokens: 5 }), h.deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(answer);
    expect(h.sent[0]!.headers.accept).toBe("application/json");
    expect(h.sent[0]!.body.stream).toBeUndefined();
    expect(h.finished).toEqual([{ id: 1, status: "ok", inputTokens: 12, cachedTokens: 0, outputTokens: 4, reasoningTokens: 0, costUsd: 0.000031 }]);
  });

  test("a call the endpoint refuses is passed back as it came and recorded as failed, at no cost", async () => {
    const h = harness(() => Response.json({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }, { status: 429, headers: { "retry-after": "7" } }));
    const response = await handleGatewayRequest(call(), h.deps);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("7");
    expect(await response.json()).toMatchObject({ error: { type: "rate_limit_error" } });
    expect(h.finished).toEqual([{ id: 1, status: "failed", inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0 }]);
    expect(h.reports).toEqual([]);
  });

  test("our own key being refused is reported to the operator", async () => {
    for (const status of [401, 402, 403]) {
      const h = harness(() => Response.json({ error: "no" }, { status }));
      expect((await handleGatewayRequest(call(), h.deps)).status).toBe(status);
      expect(h.finished[0]!.status).toBe("failed");
      expect(h.reports).toEqual(["gateway upstream request"]);
    }
  });

  test("a call that finishes with no cost reported is recorded as unpriced and reported", async () => {
    const streamed = harness(() => sse(START + TEXT + delta({ output_tokens: 42 }) + STOP));
    await settle(streamed, await handleGatewayRequest(call(), streamed.deps));
    expect(streamed.finished).toEqual([{ id: 1, status: "unpriced", inputTokens: 105, cachedTokens: 90, outputTokens: 42, reasoningTokens: 0, costUsd: 0 }]);
    expect(streamed.reports).toEqual(["gateway unpriced call"]);
    const whole = harness(() => Response.json({ type: "message", usage: { input_tokens: 1, output_tokens: 1, cost: -1 } }));
    await handleGatewayRequest(call({ messages: [] }), whole.deps);
    expect(whole.finished[0]).toMatchObject({ status: "unpriced", costUsd: 0 });
    const notJson = harness(() => new Response("<html>ok</html>"));
    await handleGatewayRequest(call({ messages: [] }), notJson.deps);
    expect(notJson.finished[0]).toMatchObject({ status: "unpriced", costUsd: 0 });
  });

  test("a stream that ends early, carries an error, or breaks is recorded as aborted with what is known", async () => {
    const early = harness(() => sse(START + TEXT));
    expect(await settle(early, await handleGatewayRequest(call(), early.deps))).toBe(START + TEXT);
    expect(early.finished).toEqual([{ id: 1, status: "aborted", inputTokens: 105, cachedTokens: 90, outputTokens: 1, reasoningTokens: 0, costUsd: 0 }]);

    const errored = harness(() => sse(START + event("error", { type: "error", error: { type: "overloaded_error", message: "busy" } })));
    await settle(errored, await handleGatewayRequest(call(), errored.deps));
    expect(errored.finished[0]).toMatchObject({ status: "aborted", costUsd: 0 });

    // The cost arrived, then the connection dropped before the last event: the cost is kept.
    let pulls = 0;
    const paid = harness(
      () =>
        new Response(
          new ReadableStream({
            pull(c) {
              if (pulls++ === 0) c.enqueue(encoder.encode(START + delta({ output_tokens: 42, cost: 0.002 })));
              else c.error(new Error("connection reset"));
            },
          }),
        ),
    );
    expect(await settle(paid, await handleGatewayRequest(call(), paid.deps))).toStartWith("stream error");
    expect(paid.finished).toEqual([{ id: 1, status: "aborted", inputTokens: 105, cachedTokens: 90, outputTokens: 42, reasoningTokens: 0, costUsd: 0.002 }]);
    expect([...early.reports, ...errored.reports, ...paid.reports]).toEqual([]);
  });

  test("a caller that leaves mid-stream does not stop the read: the call is recorded with its real cost", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let cancelled = false;
    const h = harness(
      () =>
        new Response(
          new ReadableStream({
            async start(c) {
              c.enqueue(encoder.encode(START));
              await gate;
              c.enqueue(encoder.encode(TEXT + delta({ output_tokens: 42, cost: 0.00123 }) + STOP));
              c.close();
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    );
    const response = await handleGatewayRequest(call(), h.deps);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(h.finished).toEqual([]);
    release();
    await Promise.all(h.kept);
    expect(cancelled).toBe(false);
    expect(h.finished).toEqual([{ id: 1, status: "ok", inputTokens: 105, cachedTokens: 90, outputTokens: 42, reasoningTokens: 0, costUsd: 0.00123 }]);
  });

  test("the function is kept alive until the call is recorded", async () => {
    const h = harness();
    const response = await handleGatewayRequest(call(), h.deps);
    expect(h.kept).toHaveLength(1);
    await Promise.all(h.kept);
    expect(h.finished).toHaveLength(1);
    expect(await response.text()).toBe(WHOLE);
  });

  test("an endpoint that cannot be reached is tried again, then recorded as aborted", async () => {
    const flaky = harness((attempt) => {
      if (attempt < 3) throw new TypeError("fetch failed");
      return sse(WHOLE);
    });
    const ok = await handleGatewayRequest(call(), flaky.deps);
    expect(ok.status).toBe(200);
    await settle(flaky, ok);
    expect(flaky.sent).toHaveLength(3);
    expect(flaky.started).toHaveLength(1);
    expect(flaky.finished.map((row) => row.status)).toEqual(["ok"]);

    const down = harness(() => {
      throw new TypeError("fetch failed");
    });
    const response = await handleGatewayRequest(call(), down.deps);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("fetch failed");
    expect(down.sent).toHaveLength(3);
    expect(down.finished).toEqual([{ id: 1, status: "aborted", costUsd: 0 }]);
    expect(down.reports).toEqual(["gateway upstream request"]);
  });

  test("an endpoint that never answers is given up on, and the call recorded as aborted", async () => {
    const h = harness((_attempt, signal) => new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))), { upstreamTimeoutMs: 20 });
    const response = await handleGatewayRequest(call(), h.deps);
    expect(response.status).toBe(502);
    expect(h.sent).toHaveLength(1);
    expect(h.finished).toEqual([{ id: 1, status: "aborted", costUsd: 0 }]);
  });

  test("a ledger write that fails is tried again; one that keeps failing is reported and the answer still arrives", async () => {
    let failures = 2;
    const writes: UsageCallResult[] = [];
    const retried = harness(undefined, {
      finish: async (_id, result) => {
        if (failures-- > 0) throw new Error("db blip");
        writes.push(result);
        return true;
      },
    });
    await settle(retried, await handleGatewayRequest(call(), retried.deps));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ status: "ok", costUsd: 0.00123 });
    expect(retried.reports).toEqual([]);

    let attempts = 0;
    const stuck = harness(undefined, {
      finish: async () => {
        attempts++;
        throw new Error("db down");
      },
    });
    const response = await handleGatewayRequest(call(), stuck.deps);
    expect(await settle(stuck, response)).toBe(WHOLE);
    expect(attempts).toBe(4);
    expect(stuck.reports).toEqual(["gateway ledger write"]);
  });
});

// ---- Against a real database ------------------------------------------------

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest";
const NAME = `sandchest_gateway_test_${process.pid}`;

describe("gateway: the ledger in Postgres", () => {
  let admin: postgres.Sql | undefined;
  let database: Db;
  let available = true;
  let org: { id: string };
  let repo: { id: string };
  let pr = 0;

  beforeAll(async () => {
    try {
      admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
      await admin.unsafe(`create database ${NAME}`);
    } catch {
      available = false;
      return;
    }
    const url = new URL(ADMIN_URL);
    url.pathname = `/${NAME}`;
    database = createDb(url.toString(), { max: 5 });
    await migrate(database);
    const installed = await upsertInstallation(database, 801, { githubAccountId: 81, githubLogin: "acme", type: "Organization" }, [{ githubRepoId: 82, fullName: "acme/api", private: true, defaultBranch: "main" }]);
    org = installed.org;
    repo = installed.repos[0]!;
  });

  afterAll(async () => {
    if (!available) return;
    await database.$client.end();
    await admin!.unsafe(`drop database if exists ${NAME} with (force)`);
    await admin!.end();
  });

  async function runningScan(status: "running" | "queued" | "completed" = "running"): Promise<string> {
    pr++;
    const { scan } = await createScan(database, { repoId: repo.id, orgId: org.id, kind: "pr_review", trigger: "webhook", headSha: `head${pr}`, prNumber: pr });
    await database.$client`update scans set status = ${status} where id = ${scan.id}`;
    return scan.id;
  }

  const live = (answer: () => Response = () => sse(WHOLE)): Harness =>
    harness(answer, {
      now: undefined,
      budget: (scanId) => usageBudgetState(database, scanId, STALE_CALL_SECONDS),
      start: (scanId, started) => startUsageCall(database, scanId, started),
      finish: (id, result) => finishUsageCall(database, id, result),
    });
  const tokenFor = (scanId: string, ceilingMicroUsd: number) => ({ authorization: `Bearer ${mintGatewayToken({ scanId, stage: "verify", attempt: 3, ceilingMicroUsd, ttlSeconds: 600 }, SECRET)}` });

  test("rows written the old way are attempt 0 and ok; the new columns hold what they are given", async () => {
    if (!available) return;
    const scanId = await runningScan();
    await insertUsage(database, scanId, [
      { kind: "model", stage: "hunt", role: "hunt", inputTokens: 10, costUsd: 0.25, costSource: "priced" },
      { kind: "model", stage: "hunt", role: "hunt", costUsd: 0, costSource: "provider", attempt: 4, status: "failed" },
    ]);
    const rows = await scanUsageRows(database, scanId);
    expect(rows.map((row) => [row.attempt, row.status, row.costUsd])).toEqual([
      [0, "ok", "0.2500000000"],
      [4, "failed", "0.0000000000"],
    ]);
  });

  test("the budget state of a scan: its status, exact spend and the calls that need care", async () => {
    if (!available) return;
    expect(await usageBudgetState(database, "00000000-0000-4000-8000-000000000000", STALE_CALL_SECONDS)).toBeUndefined();
    const scanId = await runningScan();
    expect(await usageBudgetState(database, scanId, STALE_CALL_SECONDS)).toEqual({ scanStatus: "running", spentUsd: "0", inFlight: 0, lost: 0, unpriced: 0, abortedUnpriced: 0 });
    await insertUsage(database, scanId, [
      { kind: "model", stage: "hunt", role: "hunt", costUsd: "0.1000000001", costSource: "provider" },
      { kind: "sandbox", stage: "sandbox", seconds: 30, costUsd: 0.0003, costSource: "sandbox" },
      { kind: "model", stage: "verify", role: "agent", costUsd: 0, costSource: "provider", status: "unpriced" },
      { kind: "model", stage: "verify", role: "agent", costUsd: 0, costSource: "provider", status: "aborted" },
      { kind: "model", stage: "verify", role: "agent", costUsd: 0.002, costSource: "provider", status: "aborted" },
      { kind: "model", stage: "verify", role: "agent", costUsd: 0, costSource: "provider", status: "failed" },
    ]);
    const fresh = await startUsageCall(database, scanId, { stage: "verify", role: "agent", attempt: 1 });
    const old = await startUsageCall(database, scanId, { stage: "verify", role: "agent", attempt: 1 });
    await database.$client`update scan_usage set created_at = now() - interval '16 minutes' where id = ${old}`;
    expect(await usageBudgetState(database, scanId, STALE_CALL_SECONDS)).toEqual({ scanStatus: "running", spentUsd: "0.1023000001", inFlight: 1, lost: 1, unpriced: 1, abortedUnpriced: 1 });
    // Another scan's rows are another scan's.
    expect((await usageBudgetState(database, await runningScan("queued"), STALE_CALL_SECONDS))!).toMatchObject({ scanStatus: "queued", spentUsd: "0", inFlight: 0 });
    expect(await finishUsageCall(database, fresh, { status: "ok", inputTokens: 5, costUsd: 0.01 })).toBe(true);
    expect((await usageBudgetState(database, scanId, STALE_CALL_SECONDS))!).toMatchObject({ spentUsd: "0.1123000001", inFlight: 0, lost: 1 });
  });

  test("a call's row is closed once: a second close changes nothing", async () => {
    if (!available) return;
    const scanId = await runningScan();
    const id = await startUsageCall(database, scanId, { stage: "variants", attempt: 2 });
    expect(await scanUsageRows(database, scanId)).toMatchObject([{ id, kind: "model", stage: "variants", role: null, attempt: 2, status: "started", costUsd: "0.0000000000", costSource: "provider" }]);
    expect(await finishUsageCall(database, id, { status: "ok", inputTokens: 105, cachedTokens: 90, outputTokens: 42, costUsd: "0.0012345678901" })).toBe(true);
    expect(await finishUsageCall(database, id, { status: "failed", costUsd: 9 })).toBe(false);
    expect(await scanUsageRows(database, scanId)).toMatchObject([{ status: "ok", inputTokens: 105, cachedTokens: 90, outputTokens: 42, reasoningTokens: 0, costUsd: "0.0012345679" }]);
  });

  test("calls are recorded as they are made, and refused once what is recorded reaches the ceiling", async () => {
    if (!available) return;
    const scanId = await runningScan();
    const h = live();
    // Each call costs 0.00123: the ceiling of 0.003 is reached by the third.
    const headers = tokenFor(scanId, 3_000);
    for (let i = 0; i < 3; i++) {
      const response = await handleGatewayRequest(call(undefined, headers), h.deps);
      expect(response.status).toBe(200);
      expect(await settle(h, response)).toBe(WHOLE);
    }
    const refused = await handleGatewayRequest(call(undefined, headers), h.deps);
    expect(refused.status).toBe(402);
    expect(h.sent).toHaveLength(3);
    const rows = await scanUsageRows(database, scanId);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ kind: "model", stage: "verify", role: "agent", attempt: 3, status: "ok", inputTokens: 105, cachedTokens: 90, outputTokens: 42, costUsd: "0.0012300000", costSource: "provider" });
    // What the engine itself spent counts toward the same ceiling.
    const other = await runningScan();
    await insertUsage(database, other, [{ kind: "model", stage: "hunt", role: "hunt", costUsd: 0.003, costSource: "provider" }]);
    expect((await handleGatewayRequest(call(undefined, tokenFor(other, 3_000)), h.deps)).status).toBe(402);
    expect(h.sent).toHaveLength(3);
  });

  test("one unpriced call stops the scan's later calls", async () => {
    if (!available) return;
    const scanId = await runningScan();
    const h = live(() => sse(START + delta({ output_tokens: 42 }) + STOP));
    await settle(h, await handleGatewayRequest(call(undefined, tokenFor(scanId, 300_000)), h.deps));
    expect((await handleGatewayRequest(call(undefined, tokenFor(scanId, 300_000)), h.deps)).status).toBe(402);
    expect(h.sent).toHaveLength(1);
    expect((await scanUsageRows(database, scanId)).map((row) => row.status)).toEqual(["unpriced"]);
  });

  test("a token is only good while its scan runs", async () => {
    if (!available) return;
    const h = live();
    const scanId = await runningScan("queued");
    expect((await handleGatewayRequest(call(undefined, tokenFor(scanId, 300_000)), h.deps)).status).toBe(403);
    await database.$client`update scans set status = 'running' where id = ${scanId}`;
    await settle(h, await handleGatewayRequest(call(undefined, tokenFor(scanId, 300_000)), h.deps));
    await database.$client`update scans set status = 'completed' where id = ${scanId}`;
    expect((await handleGatewayRequest(call(undefined, tokenFor(scanId, 300_000)), h.deps)).status).toBe(403);
    expect((await handleGatewayRequest(call(undefined, tokenFor("00000000-0000-4000-8000-000000000000", 300_000)), h.deps)).status).toBe(403);
    expect(h.sent).toHaveLength(1);
  });

  test("the route is off until a gateway secret is set", async () => {
    if (!available) return;
    const url = new URL(ADMIN_URL);
    url.pathname = `/${NAME}`;
    const saved = { ...process.env };
    Object.assign(process.env, { DATABASE_URL: url.toString(), GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "unused", GITHUB_WEBHOOK_SECRET: "unused", SANDCHEST_APP_URL: "https://sandchest.test" });
    delete process.env.SANDCHEST_GATEWAY_SECRET;
    resetConfig();
    try {
      expect((await route(call())).status).toBe(404);
      process.env.SANDCHEST_GATEWAY_SECRET = SECRET;
      resetConfig();
      expect((await route(call(undefined, { authorization: "Bearer nope" }))).status).toBe(401);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      resetConfig();
    }
  });
});
