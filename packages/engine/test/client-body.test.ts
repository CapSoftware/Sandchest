import { describe, expect, test } from "bun:test";
import { createLlmClient, type ChatRequest, type LlmConfig } from "../src/llm";
import { sse, textReply } from "./helpers";

const base: LlmConfig = { baseUrl: "http://fake/v1", apiKey: "k", model: "model-a" };
const tool = { type: "function" as const, function: { name: "read_file", description: "Reads a file.", parameters: { type: "object" } } };
const ask: ChatRequest = { role: "hunt", messages: [{ role: "user", content: "hi" }], maxTokens: 50, reasoningEffort: null };

/** The raw request body the client sends for `request` under `config`. */
async function sent(config: LlmConfig, request: ChatRequest = ask): Promise<string> {
  let body = "";
  const fetch = (async (_url: string, init: RequestInit) => {
    body = String(init.body);
    return sse(textReply("ok"));
  }) as unknown as typeof globalThis.fetch;
  await createLlmClient(config, { fetch }).chat(request);
  return body;
}

describe("LlmConfig.body", () => {
  test("its fields are set on every request", async () => {
    const body = JSON.parse(await sent({ ...base, body: { reasoning: { enabled: false }, routing: { order: ["a", "b"] } } }));
    expect(body).toMatchObject({ reasoning: { enabled: false }, routing: { order: ["a", "b"] }, model: "model-a", max_tokens: 50, stream: true });
  });

  test("it never overrides what the request sets", async () => {
    const config = { ...base, body: { model: "other", messages: [], stream: false, stream_options: {}, max_tokens: 1, tools: [], tool_choice: "none", reasoning_effort: "low", temperature: 2 } };
    const body = JSON.parse(await sent(config, { ...ask, role: "skeptic", reasoningEffort: "high", tools: [tool], toolChoice: "auto", temperature: 0.5 }));
    expect(body).toEqual({
      model: "model-a",
      messages: ask.messages,
      stream: true,
      stream_options: { include_usage: true },
      tools: [tool],
      tool_choice: "auto",
      max_tokens: 50,
      temperature: 0.5,
      reasoning_effort: "high",
    });
  });

  test("unset, the request is byte for byte what it was", async () => {
    const plain = await sent(base);
    expect(plain).toBe(JSON.stringify({ model: "model-a", messages: ask.messages, stream: true, stream_options: { include_usage: true }, max_tokens: 50 }));
    expect(await sent({ ...base, body: undefined })).toBe(plain);
  });
});
