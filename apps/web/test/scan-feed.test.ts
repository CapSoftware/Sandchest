/** The scan live feed's stream: what it sends, and the bounds on what one viewer can hold open. */
import { describe, expect, test } from "bun:test";
import { feedResponse, type FeedPoll } from "@/server/scan-feed";

const URL_BASE = "https://sandchest.test/api/scans/00000000-0000-0000-0000-000000000000/events";

function get(options: { after?: number; lastEventId?: number; signal?: AbortSignal } = {}): Request {
  return new Request(`${URL_BASE}?after=${options.after ?? 0}`, {
    headers: options.lastEventId !== undefined ? { "last-event-id": String(options.lastEventId) } : {},
    signal: options.signal,
  });
}

/** A scan that is running and has written nothing new. */
const running = async (): Promise<FeedPoll> => ({ status: "running", startedAt: "2026-01-01T00:00:00.000Z", events: [] });

/** Reads the whole stream, failing if it is still open after `withinMs`. */
async function readAll(response: Response, withinMs: number): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + withinMs;
  for (;;) {
    const left = deadline - Date.now();
    const next = await Promise.race([reader.read(), new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), Math.max(0, left)))]);
    if (next === "timeout") {
      await reader.cancel();
      throw new Error(`stream still open after ${withinMs} ms`);
    }
    if (next.done) return text;
    text += decoder.decode(next.value);
  }
}

/** Reads until `pattern` shows up, then hangs up. */
async function readUntil(response: Response, pattern: string): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes(pattern)) {
    const next = await reader.read();
    if (next.done) break;
    text += decoder.decode(next.value);
  }
  await reader.cancel();
  return text;
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

describe("scan live feed", () => {
  test("sends the status, the new lines with their seq, and the end once the scan finishes", async () => {
    let calls = 0;
    const poll = async (after: number): Promise<FeedPoll> => {
      calls++;
      if (calls === 1) {
        expect(after).toBe(3);
        return { status: "running", startedAt: "2026-01-01T00:00:00.000Z", events: [{ seq: 4, type: "stage:hunt", message: "Hunting", createdAt: "2026-01-01T00:00:01.000Z" }] };
      }
      expect(after).toBe(4);
      return { status: "completed", startedAt: "2026-01-01T00:00:00.000Z", events: [] };
    };
    const text = await readAll(feedResponse(get({ after: 3 }), poll, "alice", { pollMs: 5 }), 1_000);
    expect(text).toContain('event: status\ndata: {"status":"running","startedAt":"2026-01-01T00:00:00.000Z"}');
    expect(text).toContain('id: 4\ndata: {"type":"stage:hunt","message":"Hunting","at":"2026-01-01T00:00:01.000Z"}');
    expect(text).toContain('event: end\ndata: {"status":"completed"}');
  });

  test("one viewer holds a few streams at once; more get 429 until one of theirs ends", async () => {
    const options = { pollMs: 5, perViewer: 2 };
    const open = [feedResponse(get(), running, "alice", options), feedResponse(get(), running, "alice", options)];
    expect(open.map((response) => response.status)).toEqual([200, 200]);
    // Streams within the limit still carry the feed.
    expect(await readUntil(open[0]!, "event: status")).toContain('"status":"running"');
    await tick();

    // The first hung up, so its slot is free again; the limit holds with both open.
    const third = feedResponse(get(), running, "alice", options);
    expect(third.status).toBe(200);
    const over = feedResponse(get(), running, "alice", options);
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBeTruthy();

    // Someone else, and operators, are not counted against Alice.
    const bob = feedResponse(get(), running, "bob", options);
    expect(bob.status).toBe(200);
    const operator = feedResponse(get(), running, null, options);
    expect(operator.status).toBe(200);

    for (const response of [open[1]!, third, bob, operator]) await response.body!.cancel();
    await tick();
    expect(feedResponse(get(), running, "alice", options).status).toBe(200);
  });

  test("a stream that finishes, aborts or fails gives its slot back", async () => {
    const options = { pollMs: 5, perViewer: 1 };
    const finished = async (): Promise<FeedPoll> => ({ status: "completed", startedAt: null, events: [] });
    await readAll(feedResponse(get(), finished, "carol", options), 1_000);

    const controller = new AbortController();
    const aborted = feedResponse(get({ signal: controller.signal }), running, "carol", options);
    expect(aborted.status).toBe(200);
    controller.abort();
    await readAll(aborted, 1_000);

    const broken = async (): Promise<FeedPoll> => {
      throw new Error("database went away");
    };
    const failed = feedResponse(get(), broken, "carol", options);
    expect(failed.status).toBe(200);
    await readAll(failed, 1_000).catch(() => {});
    await tick();

    const again = feedResponse(get(), running, "carol", options);
    expect(again.status).toBe(200);
    await again.body!.cancel();
  });

  test("an aborted request ends the stream at once, not after the pause", async () => {
    const controller = new AbortController();
    const response = feedResponse(get({ signal: controller.signal }), running, "dave", { pollMs: 60_000 });
    await tick();
    controller.abort();
    const started = Date.now();
    await readAll(response, 1_000);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("a stream ends after its lifetime, without an end, and the reconnect picks up after the last seq it sent", async () => {
    let seq = 10;
    const growing = async (after: number): Promise<FeedPoll> => ({
      status: "running",
      startedAt: null,
      events: seq < 12 ? [{ seq: ++seq, type: "line", message: `line ${seq}`, createdAt: "2026-01-01T00:00:00.000Z" }].filter((e) => e.seq > after) : [],
    });
    const text = await readAll(feedResponse(get({ after: 10 }), growing, "erin", { pollMs: 5, lifetimeMs: 100 }), 2_000);
    expect(text).not.toContain("event: end");
    // A short retry hint, so the browser's EventSource comes back quickly.
    expect(text).toMatch(/^retry: \d+$/m);
    expect(text).toContain("id: 12\n");

    const seen: number[] = [];
    const resumed = async (after: number): Promise<FeedPoll> => {
      seen.push(after);
      return { status: "completed", startedAt: null, events: [] };
    };
    // EventSource sends the last id it saw; that wins over the page's original `after`.
    await readAll(feedResponse(get({ after: 10, lastEventId: 12 }), resumed, "erin", { pollMs: 5 }), 1_000);
    expect(seen).toEqual([12]);
  });

  test("polls back off while nothing changes, and catch up again when lines arrive", async () => {
    let calls = 0;
    const quiet = async (): Promise<FeedPoll> => {
      calls++;
      return { status: "queued", startedAt: null, events: [] };
    };
    await readAll(feedResponse(get(), quiet, "frank", { pollMs: 5, idlePollMs: 80, lifetimeMs: 400 }), 2_000);
    // Without backing off this would be about 80 polls.
    expect(calls).toBeLessThan(20);

    const times: number[] = [];
    let seq = 0;
    const busy = async (): Promise<FeedPoll> => {
      times.push(Date.now());
      // Quiet for a while, then a line on every poll.
      const events = times.length > 6 ? [{ seq: ++seq, type: "line", message: "x", createdAt: "2026-01-01T00:00:00.000Z" }] : [];
      return { status: times.length > 12 ? "completed" : "running", startedAt: null, events };
    };
    await readAll(feedResponse(get(), busy, "frank", { pollMs: 5, idlePollMs: 200, lifetimeMs: 5_000 }), 5_000);
    const gaps = times.slice(1).map((t, i) => t - times[i]!);
    // Slowed down while idle, back to the quick poll once lines flow.
    expect(Math.max(...gaps.slice(0, 6))).toBeGreaterThanOrEqual(60);
    expect(Math.max(...gaps.slice(8))).toBeLessThan(60);
  });
});
