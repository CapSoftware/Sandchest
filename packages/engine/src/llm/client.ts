import { ROLE_REASONING, type LlmConfig } from "./config";
import { LlmError, errorFromResponse } from "./errors";
import { readSse } from "./sse";
import type { AssistantMessage, ChatDelta, ChatRequest, ChatResult, ToolCall, ToolChoice, Usage } from "./types";

export interface LlmClientOptions {
  /** Custom fetch, for tests or instrumentation. */
  fetch?: typeof fetch;
  /** Total attempts per request, including the first. Default 5. */
  maxAttempts?: number;
  /** Longest silence tolerated while waiting for the next byte. Default 120s. */
  idleTimeoutMs?: number;
  /** Longest a single attempt may take, even while bytes keep arriving. Default 10 minutes. */
  requestTimeoutMs?: number;
  /** First backoff delay; doubles per attempt with full jitter. Default 1s. */
  retryBaseMs?: number;
  /** Upper bound for any single backoff, including server-requested delays. Default 60s. */
  retryMaxMs?: number;
}

export interface LlmClient {
  readonly config: LlmConfig;
  /**
   * Sends one chat-completions request, streaming the response.
   *
   * Transient failures (network errors, timeouts, 408/409/429/5xx, truncated
   * streams) are retried with backoff, honouring `retry-after`, for as long as
   * nothing has been delivered to `onDelta`. Quota errors throw `LlmQuotaError`
   * immediately.
   */
  chat(request: ChatRequest, onDelta?: (delta: ChatDelta) => void): Promise<ChatResult>;
}

export function createLlmClient(config: LlmConfig, options: LlmClientOptions = {}): LlmClient {
  const fetchImpl = options.fetch ?? fetch;
  const maxAttempts = options.maxAttempts ?? 5;
  const idleTimeoutMs = options.idleTimeoutMs ?? 120_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 600_000;
  const retryBaseMs = options.retryBaseMs ?? 1_000;
  const retryMaxMs = options.retryMaxMs ?? 60_000;

  const url = `${config.baseUrl}/chat/completions`;
  const headers = {
    "content-type": "application/json",
    accept: "text/event-stream",
    authorization: `Bearer ${config.apiKey}`,
  };

  async function attempt(request: ChatRequest, body: string, onDelta?: (delta: ChatDelta) => void) {
    const idle = new AbortController();
    const overall = AbortSignal.timeout(requestTimeoutMs);
    const signal = AbortSignal.any(request.signal ? [request.signal, idle.signal, overall] : [idle.signal, overall]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => idle.abort(), idleTimeoutMs);
    };

    touch();
    try {
      const response = await fetchImpl(url, { method: "POST", headers, body, signal });
      if (!response.ok) throw await errorFromResponse(response);
      if (!response.body) throw new LlmError("Model response had no body", { retryable: true });

      const stream = new StreamAccumulator(onDelta);
      for await (const data of readSse(response.body)) {
        touch();
        if (data === "[DONE]") break;
        stream.push(data);
      }
      return stream.result();
    } catch (error) {
      if (request.signal?.aborted) throw request.signal.reason;
      if (idle.signal.aborted) {
        throw new LlmError(`Model sent nothing for ${idleTimeoutMs}ms`, { retryable: true, cause: error });
      }
      if (overall.aborted) {
        throw new LlmError(`Model response took longer than ${requestTimeoutMs}ms`, { retryable: true, cause: error });
      }
      if (error instanceof LlmError) throw error;
      throw new LlmError(`Model request failed: ${(error as Error).message}`, { retryable: true, cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    config,
    async chat(request, onDelta) {
      const body = buildBody(config, request);
      let delivered = false;
      const emit = onDelta
        ? (delta: ChatDelta) => {
            delivered = true;
            onDelta(delta);
          }
        : undefined;

      for (let attemptNumber = 1; ; attemptNumber++) {
        try {
          return { ...(await attempt(request, body, emit)), retries: attemptNumber - 1 };
        } catch (error) {
          if (!(error instanceof LlmError) || !error.retryable || delivered || attemptNumber >= maxAttempts) {
            throw error;
          }
          const backoff = Math.random() * Math.min(retryMaxMs, retryBaseMs * 2 ** (attemptNumber - 1));
          await sleep(Math.min(retryMaxMs, error.options.retryAfterMs ?? backoff), request.signal);
        }
      }
    },
  };
}

function buildBody(config: LlmConfig, request: ChatRequest): string {
  const body: Record<string, unknown> = {
    model: config.models?.[request.role] ?? config.model,
    messages: request.messages,
    stream: true,
    stream_options: { include_usage: true },
  };

  if (request.tools?.length) {
    body.tools = request.tools;
    if (request.toolChoice) body.tool_choice = toWireToolChoice(request.toolChoice);
  }
  if (request.responseFormat) body.response_format = request.responseFormat;
  if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
  // Sampling is sent only when configured; unset means the endpoint's own default (see LlmConfig).
  const temperature = request.temperature ?? config.temperature;
  if (temperature !== undefined) body.temperature = temperature;
  const seed = request.seed ?? config.seed;
  if (seed !== undefined) body.seed = seed;

  const effort = request.reasoningEffort === undefined ? ROLE_REASONING[request.role] : request.reasoningEffort;
  if (effort) body.reasoning_effort = effort;

  // Endpoint options go underneath, so the request's own fields always win.
  return JSON.stringify(config.body ? { ...config.body, ...body } : body);
}

function toWireToolChoice(choice: ToolChoice) {
  return typeof choice === "string" ? choice : { type: "function", function: { name: choice.name } };
}

/** Shape of one streamed chunk. */
interface Chunk {
  error?: { message?: string } | string;
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number } | null;
    completion_tokens_details?: { reasoning_tokens?: number } | null;
    /** What the call cost in USD, on endpoints that report it. */
    cost?: unknown;
  } | null;
}

class StreamAccumulator {
  private content = "";
  private reasoning = "";
  private finishReason = "";
  private readonly toolCalls: ToolCall[] = [];
  private usage: Usage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  private costUsd: number | undefined;

  constructor(private readonly onDelta?: (delta: ChatDelta) => void) {}

  push(data: string): void {
    let chunk: Chunk;
    try {
      chunk = JSON.parse(data) as Chunk;
    } catch (cause) {
      throw new LlmError("Model stream contained malformed JSON", { retryable: true, cause });
    }

    if (chunk.error) {
      const message = typeof chunk.error === "string" ? chunk.error : chunk.error.message;
      throw new LlmError(`Model stream failed: ${message ?? "unknown error"}`, { retryable: true });
    }
    if (chunk.usage) {
      this.usage = {
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        cachedTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
        reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0,
      };
      const cost = chunk.usage.cost;
      this.costUsd = typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
    }

    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) this.finishReason = choice.finish_reason;

    const delta = choice.delta;
    if (!delta) return;

    if (delta.content) {
      this.content += delta.content;
      this.onDelta?.({ type: "content", text: delta.content });
    }
    if (delta.reasoning_content) {
      this.reasoning += delta.reasoning_content;
      this.onDelta?.({ type: "reasoning", text: delta.reasoning_content });
    }
    for (const part of delta.tool_calls ?? []) {
      const index = part.index ?? this.toolCalls.length;
      const call = (this.toolCalls[index] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
      if (part.id) call.id = part.id;
      if (part.function?.name) call.function.name ||= part.function.name;
      if (part.function?.arguments) call.function.arguments += part.function.arguments;
    }
  }

  result(): ChatResult {
    if (!this.finishReason) {
      throw new LlmError("Model stream ended before completion", { retryable: true });
    }
    // A call without an id could not be answered, so give it one.
    const toolCalls = this.toolCalls.filter(Boolean).map((call, i) => (call.id ? call : { ...call, id: `call_${i}` }));
    const message: AssistantMessage = { role: "assistant", content: this.content || null };
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
      if (this.reasoning) message.reasoning_content = this.reasoning;
    }
    return {
      content: this.content,
      reasoning: this.reasoning,
      toolCalls,
      finishReason: this.finishReason,
      usage: this.usage,
      ...(this.costUsd !== undefined && { costUsd: this.costUsd }),
      message,
      retries: 0,
    };
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
