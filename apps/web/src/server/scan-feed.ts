/**
 * A scan's live feed as server-sent events, polled from the database. Each
 * stream costs a query per poll for as long as it is open, so it is bounded:
 * it polls slower while nothing happens, ends after a minute (the browser's
 * EventSource reconnects on its own, resuming from the last seq it saw, and
 * access is checked again), stops as soon as the client goes, and one person
 * holds only a few at a time on an instance.
 */

export interface FeedPoll {
  status: string | null;
  startedAt: string | null;
  events: Array<{ seq: number; type: string; message: string; createdAt: string }>;
}

export interface FeedOptions {
  /** The pause between polls while lines are arriving. */
  pollMs: number;
  /** The longest pause, reached by doubling while nothing changes. */
  idlePollMs: number;
  /** How long one stream stays open before the client has to reconnect. */
  lifetimeMs: number;
  /** Streams one person may hold open at once on this instance. */
  perViewer: number;
}

/** Events are written in batches every 150 ms; polling twice a second keeps the feed close behind. */
const DEFAULTS: FeedOptions = { pollMs: 500, idlePollMs: 3_000, lifetimeMs: 60_000, perViewer: 6 };
const FINISHED = new Set(["completed", "failed", "cancelled", "refused"]);
/** How soon the browser reconnects after a stream reaches its lifetime. */
const RETRY_MS = 1_000;

const open = new Map<string, number>();

/**
 * The feed for one viewer, from `poll` (new events after a seq, and the
 * scan's status). `viewer` is the signed-in person's id, or null for operators.
 */
export function feedResponse(request: Request, poll: (after: number) => Promise<FeedPoll>, viewer: string | null, options: Partial<FeedOptions> = {}): Response {
  const { pollMs, idlePollMs, lifetimeMs, perViewer } = { ...DEFAULTS, ...options };
  if (viewer !== null) {
    const held = open.get(viewer) ?? 0;
    if (held >= perViewer) return Response.json({ error: "too many live feeds open" }, { status: 429, headers: { "retry-after": "30" } });
    open.set(viewer, held + 1);
  }
  let released = false;
  const release = () => {
    if (released || viewer === null) return;
    released = true;
    const held = (open.get(viewer) ?? 1) - 1;
    if (held > 0) open.set(viewer, held);
    else open.delete(viewer);
  };

  // Resume where the client left off: after a reconnect, or after what the page already rendered.
  let after = Number(request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("after") ?? 0) || 0;
  const encoder = new TextEncoder();
  const hungUp = new AbortController();
  const stop = AbortSignal.any([request.signal, hungUp.signal]);
  const deadline = Date.now() + lifetimeMs;
  // The status is sent first and whenever it changes, with when the scan started: the page's
  // label, clock and stage track follow it without asking again.
  let lastStatus: string | null | undefined;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string) => {
        if (!stop.aborted) controller.enqueue(encoder.encode(text));
      };
      try {
        send(`retry: ${RETRY_MS}\n\n`);
        let pause = pollMs;
        while (!stop.aborted && Date.now() < deadline) {
          // One query per poll: new events and whether the scan has finished.
          const { status, startedAt, events } = await poll(after);
          const changed = status !== lastStatus || events.length > 0;
          if (status !== lastStatus) {
            lastStatus = status;
            send(`event: status\ndata: ${JSON.stringify({ status, startedAt })}\n\n`);
          }
          for (const event of events) {
            after = event.seq;
            // One event name for every line; its type (stage:hunt, finding, ...) rides in the data.
            send(`id: ${event.seq}\ndata: ${JSON.stringify({ type: event.type, message: event.message, at: event.createdAt })}\n\n`);
          }
          if (!status || FINISHED.has(status)) {
            send(`event: end\ndata: ${JSON.stringify({ status })}\n\n`);
            break;
          }
          // A queued scan, or a quiet stretch of a running one, needs no query twice a second.
          pause = changed ? pollMs : Math.min(pause * 2, idlePollMs);
          await sleep(Math.min(pause, deadline - Date.now()), stop);
        }
      } finally {
        release();
        try {
          controller.close();
        } catch {
          // Already cancelled by the client.
        }
      }
    },
    cancel() {
      hungUp.abort();
      release();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" } });
}

/** Waits `ms`, or less if `signal` aborts first. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
