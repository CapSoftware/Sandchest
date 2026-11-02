import { describe, expect, test } from "bun:test";
import { createClassifier, loadClassifierConfig } from "../src/llm/classifier";

/** A fetch that answers with scripted responses and records requests. */
function scripted(...responses: Array<Response | Error>) {
  const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    requests.push({ url, headers: new Headers(init.headers), body: JSON.parse(init.body as string) });
    const next = responses.shift();
    if (!next) throw new Error("no response scripted");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, requests };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const answer = { answers: { q: { type: "noul", noul: 0.8 } }, usage: { input_tokens: 42 } };

describe("loadClassifierConfig", () => {
  test("is null unless url, key and model are all set", () => {
    expect(loadClassifierConfig({})).toBeNull();
    expect(loadClassifierConfig({ LLM_CLASSIFIER_URL: "https://x/v1", LLM_CLASSIFIER_KEY: "k" })).toBeNull();
    expect(loadClassifierConfig({ LLM_CLASSIFIER_URL: "https://x/v1", LLM_CLASSIFIER_KEY: "k", LLM_CLASSIFIER_MODEL: "m" })).toEqual({
      url: "https://x/v1",
      apiKey: "k",
      model: "m",
      longContextHeader: undefined,
    });
  });
});

describe("createClassifier", () => {
  const base = { url: "https://host/v1/systemone", apiKey: "secret", model: "m" };

  test("posts the typed-decision body with auth and parses answers", async () => {
    const { fetch, requests } = scripted(json(answer));
    const client = createClassifier({ ...base, fetch });
    const result = await client.ask("some code", { q: { type: "noul", instructions: "is it?" } });
    expect(result.answers.q).toEqual({ type: "noul", noul: 0.8 });
    expect(result.inputTokens).toBe(42);
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer secret");
    expect(requests[0]!.body).toEqual({ model: "m", state: "some code", questions: { q: { type: "noul", instructions: "is it?" } } });
  });

  test("retries 5xx then succeeds", async () => {
    const { fetch, requests } = scripted(json({ error: "down" }, 503), json(answer));
    const client = createClassifier({ ...base, fetch, maxAttempts: 3 });
    const result = await client.ask("code", { q: { type: "noul", instructions: "?" } });
    expect(result.answers.q!.type).toBe("noul");
    expect(requests).toHaveLength(2);
  });

  test("does not retry a 4xx (our bad question)", async () => {
    const { fetch, requests } = scripted(json({ detail: "bad" }, 422));
    const client = createClassifier({ ...base, fetch, maxAttempts: 3 });
    await expect(client.ask("code", { q: { type: "noul", instructions: "?" } })).rejects.toThrow("classifier 422");
    expect(requests).toHaveLength(1);
  });

  test("adds the long-context header only for oversized state", async () => {
    const { fetch, requests } = scripted(json(answer), json(answer));
    const client = createClassifier({ ...base, fetch, longContextHeader: "X-Long" });
    await client.ask("short", { q: { type: "noul", instructions: "?" } });
    expect(requests[0]!.headers.get("x-long")).toBeNull();
    await client.ask("x".repeat(100_001), { q: { type: "noul", instructions: "?" } });
    expect(requests[1]!.headers.get("x-long")).toBe("true");
  });
});
