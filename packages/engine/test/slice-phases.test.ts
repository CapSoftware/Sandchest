import { describe, expect, test } from "bun:test";
import type { ChatRequest, ChatResult, LlmClient } from "../src/llm";
import { runChangeHunt, runSliceHunt, SCORE_TASK, type SliceHuntOptions, type SlicePhase } from "../src/scan/slice";

/** A small invented service: whole-file mode, one packet. */
const REPO: Record<string, string> = {
  "src/api/users.ts": Array.from({ length: 30 }, (_, i) => `const user${i} = req.params.id;`).join("\n") + "\n",
};

const reply = (content: string): ChatResult => ({
  content,
  reasoning: "",
  toolCalls: [],
  finishReason: "stop",
  usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 2, reasoningTokens: 0 },
  message: { role: "assistant", content },
  retries: 0,
});

const contentOf = (r: ChatRequest) => (r.messages[0] as { content: string }).content;
const isScore = (r: ChatRequest) => contentOf(r).includes(SCORE_TASK);

/** Every hunt reports one idor at line 12 of the entry it is shown; every score gives it 6. `fail` throws instead. */
function client(fail?: (score: boolean) => boolean): LlmClient {
  return {
    config: { baseUrl: "http://fake", apiKey: "k", model: "m" },
    async chat(request) {
      const score = isScore(request);
      if (fail?.(score)) throw new Error("bad reply");
      const content = contentOf(request);
      if (score) {
        const ids = [...content.matchAll(/^C(\d+)\|/gm)].map((m) => `C${m[1]}|6`);
        return reply(ids.join("\n"));
      }
      const entry = content.match(/^\[(E\d+)\] \S+ (\S+)/m);
      return reply(entry ? `${entry[1]}|idor|a|${entry[2]}:12|other users|reads any user by id` : "NONE");
    },
  };
}

function options(llm: LlmClient, extra: Partial<SliceHuntOptions> = {}): SliceHuntOptions {
  return {
    client: llm,
    listFiles: async () => Object.keys(REPO),
    readFile: async (f) => REPO[f],
    indexer: { call: async <T>(tool: string) => (tool === "routes" ? { routes: [] } : { definitions: [] }) as T },
    passDelayMs: 0,
    ...extra,
  };
}

type Seen = Array<{ phase: SlicePhase; startedAt: number; endedAt: number; ok: boolean }>;
const recorder = () => {
  const seen: Seen = [];
  return { seen, onPhase: (phase: SlicePhase, startedAt: number, endedAt: number, ok: boolean) => void seen.push({ phase, startedAt, endedAt, ok }) };
};

describe("onPhase", () => {
  test("reports select, hunt and score once each, in order, back to back", async () => {
    const { seen, onPhase } = recorder();
    const before = Date.now();
    const out = await runSliceHunt(options(client(), { onPhase }));
    const after = Date.now();
    expect(out.counts.selected).toBe(1);
    expect(seen.map((s) => [s.phase, s.ok])).toEqual([
      ["select", true],
      ["hunt", true],
      ["score", true],
    ]);
    expect(seen[0]!.startedAt).toBeGreaterThanOrEqual(before);
    expect(seen.at(-1)!.endedAt).toBeLessThanOrEqual(after);
    for (const [i, s] of seen.entries()) {
      expect(s.endedAt).toBeGreaterThanOrEqual(s.startedAt);
      if (i > 0) expect(s.startedAt).toBeGreaterThanOrEqual(seen[i - 1]!.endedAt);
    }
  });

  test("the phase that failed is reported as failed, and later phases not at all", async () => {
    const hunting = recorder();
    await expect(runSliceHunt(options(client((score) => !score), { onPhase: hunting.onPhase }))).rejects.toThrow("Every hunt call failed");
    expect(hunting.seen.map((s) => [s.phase, s.ok])).toEqual([
      ["select", true],
      ["hunt", false],
    ]);

    const scoring = recorder();
    await expect(runSliceHunt(options(client((score) => score), { onPhase: scoring.onPhase }))).rejects.toThrow("Every scoring call failed");
    expect(scoring.seen.map((s) => [s.phase, s.ok])).toEqual([
      ["select", true],
      ["hunt", true],
      ["score", false],
    ]);

    const aborted = recorder();
    await expect(runSliceHunt(options(client(), { onPhase: aborted.onPhase, signal: AbortSignal.abort(new Error("Interrupted")) }))).rejects.toThrow("Interrupted");
    expect(aborted.seen.map((s) => [s.phase, s.ok])).toEqual([["select", false]]);
  });

  test("a callback that throws never stops the run", async () => {
    const out = await runSliceHunt(
      options(client(), {
        onPhase: () => {
          throw new Error("timing store down");
        },
      }),
    );
    expect(out.counts.selected).toBe(1);
  });

  test("a code change reports the same phases", async () => {
    const { seen, onPhase } = recorder();
    const file = "src/api/users.ts";
    const out = await runChangeHunt({
      client: client(),
      numstat: `3\t0\t${file}`,
      diff: [`diff --git a/${file} b/${file}`, `+++ b/${file}`, "@@ -10,0 +10,5 @@"].join("\n"),
      readFile: async (f) => REPO[f],
      passDelayMs: 0,
      onPhase,
    });
    expect(out.counts.huntCalls).toBe(3);
    expect(seen.map((s) => [s.phase, s.ok])).toEqual([
      ["select", true],
      ["hunt", true],
      ["score", true],
    ]);
  });
});
