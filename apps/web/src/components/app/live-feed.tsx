"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

export interface FeedEvent {
  seq: number;
  type: string;
  message: string;
  /** Milliseconds since the scan started. */
  at: number;
}

function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * The scan's progress as it happens. Server-rendered with everything so far,
 * then follows the event stream from the last event it has. When the scan
 * ends, the page refreshes to show the result.
 */
export function LiveFeed({ scanId, startedAt, initial, live }: { scanId: string; startedAt: number; initial: FeedEvent[]; live: boolean }) {
  const [events, setEvents] = useState(initial);
  const [following, setFollowing] = useState(live);
  const last = useRef(initial.at(-1)?.seq ?? 0);
  const end = useRef<HTMLLIElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (!live) return;
    const source = new EventSource(`/api/scans/${scanId}/events?after=${last.current}`);
    const onEvent = (event: MessageEvent<string>) => {
      const seq = Number(event.lastEventId);
      if (!seq || seq <= last.current) return;
      last.current = seq;
      const data = JSON.parse(event.data) as { message: string; at: string };
      setEvents((current) => [...current, { seq, type: event.type, message: data.message, at: Date.parse(data.at) - startedAt }]);
    };
    for (const type of ["stage", "progress", "finding", "warning"]) source.addEventListener(type, onEvent as EventListener);
    source.addEventListener("end", () => {
      source.close();
      setFollowing(false);
      router.refresh();
    });
    return () => source.close();
  }, [live, scanId, startedAt, router]);

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
        {events.map((event) => (
          <li key={event.seq} className="feed-line" data-type={event.type}>
            <span className="feed-time">{clock(event.at)}</span>
            <span className="feed-message">{event.message}</span>
          </li>
        ))}
        {following && (
          <li className="feed-line feed-cursor" ref={end}>
            <span className="feed-time" />
            <span className="cursor" aria-label="Still digging" />
          </li>
        )}
      </ol>
    </div>
  );
}
