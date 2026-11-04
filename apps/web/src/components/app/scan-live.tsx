"use client";
import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { duration, SCAN_STATUS_LABEL, timeAgo } from "@/lib/format";
import { trackOf, trackStates } from "@/lib/scan-progress";

export interface FeedEvent {
  seq: number;
  type: string;
  message: string;
  /** When it happened, in epoch milliseconds. */
  at: number;
}

export interface Live {
  kind: string;
  status: string;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** The engine's measured duration, once finished. */
  durationMs: number | null;
  /** When the server drew the page: the clock's first value, so server and client agree. */
  renderedAt: number;
  events: FeedEvent[];
  following: boolean;
  /** How many of the page's findings to show yet, when a scripted scan reveals them as its feed names them. */
  revealed?: number;
}

/** A made-up scan to play on a loop instead of following a real one: lines at seconds in, when it ends, and how long it rests done. */
export interface LiveLoop {
  script: Array<[at: number, type: string, message: string]>;
  endsAt: number;
  rest: number;
  /** Seconds in that a new visitor joins, so the feed is busy from the start. */
  joinAt: number;
}

const ACTIVE = new Set(["queued", "running", "publishing"]);
/** Exported for previews that play a made-up scan; pages use <ScanLive>. */
export const LiveContext = createContext<Live | null>(null);

export function useLive(): Live {
  const live = useContext(LiveContext);
  if (!live) throw new Error("Scan live parts must sit inside <ScanLive>");
  return live;
}

/**
 * A scan as it happens. Server-rendered with everything so far, then one
 * event stream keeps it current: the status (queued, then running), each
 * feed line, and the end, when the page refreshes to show the result. The
 * parts below read from it, wherever they sit on the page.
 */
export function ScanLive({ scanId, initial, loop, children }: { scanId: string; initial: Omit<Live, "following">; loop?: LiveLoop; children: ReactNode }) {
  const [state, setState] = useState<Live>({ ...initial, following: ACTIVE.has(initial.status), revealed: loop ? 0 : undefined });
  const last = useRef(initial.events.at(-1)?.seq ?? 0);
  const router = useRouter();
  const live = ACTIVE.has(initial.status) && !loop;
  useLoop(loop, setState);

  useEffect(() => {
    if (!live) return;
    const source = new EventSource(`/api/scans/${scanId}/events?after=${last.current}`);
    source.addEventListener("status", (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as { status: string | null; startedAt: string | null };
      if (!data.status) return;
      setState((current) => ({ ...current, status: data.status!, startedAt: data.startedAt ? Date.parse(data.startedAt) : current.startedAt }));
    });
    source.onmessage = (event: MessageEvent<string>) => {
      const seq = Number(event.lastEventId);
      if (!seq || seq <= last.current) return;
      last.current = seq;
      const data = JSON.parse(event.data) as { type: string; message: string; at: string };
      setState((current) => ({ ...current, events: [...current.events, { seq, type: data.type, message: data.message, at: Date.parse(data.at) }] }));
    };
    source.addEventListener("end", () => {
      source.close();
      setState((current) => ({ ...current, following: false }));
      router.refresh();
    });
    return () => source.close();
  }, [live, scanId, router]);

  return <LiveContext.Provider value={state}>{children}</LiveContext.Provider>;
}

/**
 * Plays `loop` into the live state: its lines as their times come, done at its end, then the same run again from
 * the start. Sequence numbers carry on from run to run, so the hacker's screen types each run's lines anew.
 */
function useLoop(loop: LiveLoop | undefined, setState: (update: (current: Live) => Live) => void) {
  const script = useRef(loop);
  const on = loop !== undefined;
  useEffect(() => {
    const play = script.current;
    if (!on || !play) return;
    let origin = Date.now() - play.joinAt * 1000;
    let base = 0;
    let shown = -1;
    let done: boolean | undefined;
    const tick = () => {
      const now = Date.now();
      if (now - origin >= (play.endsAt + play.rest) * 1000) {
        origin = now;
        base += play.script.length;
        shown = -1;
      }
      const t = (now - origin) / 1000;
      const lines = play.script.filter(([at]) => at <= t);
      const ended = t >= play.endsAt;
      if (lines.length === shown && ended === done) return;
      shown = lines.length;
      done = ended;
      setState((current) => ({
        ...current,
        status: ended ? "completed" : "running",
        createdAt: origin,
        startedAt: origin,
        finishedAt: ended ? origin + play.endsAt * 1000 : null,
        durationMs: ended ? play.endsAt * 1000 : null,
        events: lines.map(([at, type, message], i) => ({ seq: base + i + 1, type, message, at: origin + at * 1000 })),
        following: !ended,
        revealed: lines.filter(([, type]) => type === "finding").length,
      }));
    };
    tick();
    const timer = setInterval(tick, 200);
    return () => clearInterval(timer);
  }, [on, setState]);
}

/** Its children, once a scripted scan has revealed finding `at` (the first, by default); always, on a real scan. */
export function Reveal({ at = 0, children }: { at?: number; children: ReactNode }) {
  const { revealed } = useLive();
  return revealed === undefined || at < revealed ? children : null;
}

/** "Queued 3 min. ago", "Scanning, started 2 min. ago", "Done 1 hr. ago". Kept current while it runs. */
export function ScanStatus() {
  const { status, createdAt, startedAt, finishedAt, renderedAt } = useLive();
  const active = ACTIVE.has(status);
  const since = status === "queued" ? createdAt : active ? (startedAt ?? createdAt) : (finishedAt ?? startedAt ?? createdAt);
  const now = useNow(renderedAt, active, 15_000);
  return (
    <>
      <span className="scan-state" data-status={status}>
        {active && <span className="blink" aria-hidden="true" />}
        {SCAN_STATUS_LABEL[status] ?? status}
      </span>
      {status === "queued" ? " " : active ? ", started " : " "}
      {/* Never a time in the future: a scan that started after the page was drawn started "just now". */}
      <time dateTime={new Date(since).toISOString()}>{timeAgo(new Date(since), Math.max(now, since))}</time>
    </>
  );
}

/** How long the scan has waited or run, ticking every second while it does. */
export function ScanClock() {
  const { status, createdAt, startedAt, finishedAt, durationMs, renderedAt } = useLive();
  const active = ACTIVE.has(status);
  const queued = status === "queued";
  const from = queued ? createdAt : (startedAt ?? createdAt);
  const now = useNow(renderedAt, active, 1000);
  const ms = active ? now - from : (durationMs ?? (finishedAt ?? now) - from);
  return (
    <div className="stat">
      <dt>{queued ? "Waiting for" : active ? "Running for" : "Took"}</dt>
      <dd>{active ? clock(ms) : duration(ms)}</dd>
    </div>
  );
}

/** The time, starting from when the server drew the page (so both agree), then every `everyMs` while `ticking`. */
function useNow(renderedAt: number, ticking: boolean, everyMs: number): number {
  const [now, setNow] = useState(renderedAt);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [ticking, everyMs]);
  return now;
}

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** The scan's steps as a row of pixel bars: done in gold, the current one digging, the rest dark. */
export function ScanTrack() {
  const { kind, status, events } = useLive();
  const types = events.map((event) => event.type);
  const track = trackOf(kind, types);
  if (track.length === 0) return null;
  const states = trackStates(kind, status, types);
  const current = track[states.findIndex((s) => s === "current")];
  return (
    <div className="track" style={{ "--steps": track.length } as CSSProperties} role="list" aria-label={current ? `Now: ${current.label}` : status === "queued" ? "Waiting to start" : "Steps"}>
      {track.map((step, i) => (
        <div key={step.key} className="track-step" data-state={states[i]} role="listitem" aria-current={states[i] === "current" ? "step" : undefined}>
          <span className="track-bar" aria-hidden="true" />
          <span className="track-label">{step.label}</span>
        </div>
      ))}
    </div>
  );
}

function feedClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The feed: every line so far, the newest kept in view, a cursor while it digs. */
export function ScanFeed() {
  const { events, following, createdAt, startedAt, status } = useLive();
  const end = useRef<HTMLLIElement>(null);
  const origin = startedAt ?? createdAt;

  // Keep the newest line in view, without stealing the page's scroll.
  useEffect(() => {
    const node = end.current;
    const box = node?.parentElement?.parentElement;
    if (node && box) box.scrollTop = box.scrollHeight;
  }, [events.length]);

  return (
    <div className="feed" data-live={following ? "" : undefined}>
      <ol className="feed-lines" aria-live="polite">
        {events.length === 0 && !following && <li className="feed-line feed-empty">Nothing was recorded for this scan.</li>}
        {events.length === 0 && following && status === "queued" && <li className="feed-line feed-empty">Waiting for a free slot…</li>}
        {events.map((event) => (
          <li key={event.seq} className="feed-line" data-type={event.type.split(":")[0]}>
            <span className="feed-time">{event.type.split(":")[0] === "queue" ? "··:··" : feedClock(event.at - origin)}</span>
            <span className="feed-message">{event.message}</span>
          </li>
        ))}
        {following && (
          <li className="feed-line feed-cursor" ref={end}>
            <span className="feed-time" />
            <span className="cursor" aria-label="Still scanning" />
          </li>
        )}
      </ol>
    </div>
  );
}
