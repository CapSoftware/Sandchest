import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { generateObject, StructuredOutputError, type Message } from "../src/llm";
import { mockEndpoint, sse, textReply } from "./helpers";

const endpoint = mockEndpoint();
const schema = z.object({ severity: z.enum(["high", "low"]) });
const messages: Message[] = [{ role: "user", content: "classify" }];

describe("generateObject", () => {
  test("requests strict JSON-schema output", async () => {
    endpoint.respond(() => sse(textReply('{"severity":"high"}')));
    const result = await generateObject(endpoint.client(), { role: "structure", name: "finding", schema, messages });

    expect(result).toMatchObject({ value: { severity: "high" }, attempts: 1 });
    expect(endpoint.requests[0]!.body.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "finding",
        strict: true,
        schema: { type: "object", properties: { severity: { type: "string", enum: ["high", "low"] } }, required: ["severity"], additionalProperties: false },
      },
    });
  });

  test("feeds validation errors back and retries", async () => {
    endpoint.respond(
      () => sse(textReply('{"severity":"catastrophic"}')),
      () => sse(textReply('{"severity":"low"}')),
    );
    const result = await generateObject(endpoint.client(), { role: "structure", name: "finding", schema, messages });

    expect(result).toMatchObject({ value: { severity: "low" }, attempts: 2 });
    const retry = endpoint.requests[1]!.body.messages as Message[];
    expect(retry.at(-2)).toEqual({ role: "assistant", content: '{"severity":"catastrophic"}' });
    expect(retry.at(-1)!.content).toContain("invalid");
    expect(result.usage.inputTokens).toBe(20);
  });

  test("throws StructuredOutputError after maxAttempts", async () => {
    endpoint.respond(() => sse(textReply("nope")), () => sse(textReply("still nope")));
    const error = await generateObject(endpoint.client(), { role: "structure", name: "finding", schema, messages, maxAttempts: 2 }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(StructuredOutputError);
    expect((error as StructuredOutputError).lastOutput).toBe("still nope");
  });
});
