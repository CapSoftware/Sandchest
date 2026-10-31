import { afterAll } from "bun:test";
import { createLlmClient, type LlmClientOptions, type LlmConfig } from "../src/llm";

type Handler = (request: Request) => Response | Promise<Response>;

/**
 * A local chat-completions endpoint whose behaviour each test scripts.
 * Requests are recorded so tests can assert on what was sent.
 */
export function mockEndpoint() {
  let handlers: Handler[] = [];
  const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push({ headers: request.headers, body: (await request.json()) as Record<string, unknown> });
      const handler = handlers.shift();
      return handler ? handler(request) : new Response("no handler scripted", { status: 500 });
    },
  });
  afterAll(() => server.stop(true));

  const config: LlmConfig = { baseUrl: `http://localhost:${server.port}/v1`, apiKey: "test-key", model: "model-a" };

  return {
    config,
    requests,
    /** Scripts the next responses, one handler per request. */
    respond(...next: Handler[]) {
      handlers = next;
      requests.length = 0;
    },
    client(options: LlmClientOptions = {}) {
      return createLlmClient(config, { retryBaseMs: 1, ...options });
    },
  };
}

/** An SSE response carrying the given chunks, terminated by `[DONE]`. */
export function sse(chunks: unknown[], { done = true } = {}): Response {
  const events = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`);
  if (done) events.push("data: [DONE]\n\n");
  return new Response(events.join(""), { headers: { "content-type": "text/event-stream" } });
}

/** Chunks for a plain text reply. */
export function textReply(text: string, finish = "stop"): unknown[] {
  return [
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {}, finish_reason: finish }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 8 } } },
  ];
}

export function streamOf(...parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}
