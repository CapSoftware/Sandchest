"use client";
import { useEffect, useRef, useState } from "react";
import { addItems, type FeedItem, type FeedJob } from "@/lib/account-feed";

export type LiveState = "live" | "connecting" | "offline";

export interface AccountLive {
  /** Newest first, at most FEED_KEEP. */
  items: FeedItem[];
  /** Scans still going, newest first. */
  jobs: FeedJob[];
  state: LiveState;
}

/** A source of feed events: the server's stream, or the demo's made-up account. */
export interface FeedSource {
  /** Starts sending; returns how to stop. `after` is the newest item already shown (epoch ms). */
  open(after: number | null, on: { opening: (o: { items: FeedItem[]; jobs: FeedJob[] }) => void; item: (i: FeedItem) => void; job: (j: FeedJob | { id: string; gone: true }) => void; state: (s: LiveState) => void }): () => void;
}

/** How long the tab may be hidden before the stream is let go (it picks up where it left off on return). */
const HIDDEN_MS = 90_000;

/**
 * An account's live feed on the page: the server's history to start, then
 * whatever `source` sends. Bounded however long it runs; updates land
 * together once a frame at most; the stream is let go while the tab has
 * been hidden a while and picked up again on return. `listen` hears each new
 * item as it arrives (the hacker's screen and hands follow it).
 */
export function useAccountLive(initial: { items: FeedItem[]; jobs: FeedJob[] }, source: FeedSource | null, listen?: (item: FeedItem) => void): AccountLive {
  const [feed, setFeed] = useState<AccountLive>({ ...initial, state: source ? "connecting" : "offline" });
  const pending = useRef<{ items: FeedItem[]; jobs: Map<string, FeedJob | null>; opening: FeedJob[] | null; state: LiveState | null }>({ items: [], jobs: new Map(), opening: null, state: null });
  const frame = useRef(0);
  const heard = useRef(listen);
  heard.current = listen;
  const newest = useRef<number | null>(initial.items[0]?.at ?? null);

  useEffect(() => {
    if (!source) return;
    const flush = () => {
      frame.current = 0;
      const p = pending.current;
      pending.current = { items: [], jobs: new Map(), opening: null, state: null };
      setFeed((current) => {
        let jobs = p.opening ?? current.jobs;
        if (p.jobs.size > 0) {
          const byId = new Map(jobs.map((j) => [j.id, j]));
          for (const [id, job] of p.jobs) {
            if (job) byId.set(id, job);
            else byId.delete(id);
          }
          jobs = [...byId.values()].sort((a, b) => b.since - a.since);
        }
        const items = addItems(current.items, p.items);
        const state = p.state ?? current.state;
        return items === current.items && jobs === current.jobs && state === current.state ? current : { items, jobs, state };
      });
    };
    const later = () => {
      // Once a frame at most; a hidden tab has no frames, so a timer there.
      if (!frame.current) frame.current = document.hidden ? window.setTimeout(flush, 250) : requestAnimationFrame(flush);
    };
    let close: (() => void) | null = null;
    let hiddenTimer = 0;
    const connect = () => {
      if (close) return;
      close = source.open(newest.current, {
        opening: ({ items, jobs }) => {
          pending.current.opening = jobs;
          pending.current.jobs.clear();
          for (const item of items) pending.current.items.push(item);
          later();
        },
        item: (item) => {
          pending.current.items.push(item);
          if (newest.current === null || item.at > newest.current) newest.current = item.at;
          heard.current?.(item);
          later();
        },
        job: (job) => {
          pending.current.jobs.set(job.id, "gone" in job ? null : job);
          later();
        },
        state: (state) => {
          pending.current.state = state;
          later();
        },
      });
    };
    const disconnect = () => {
      close?.();
      close = null;
    };
    const visibility = () => {
      clearTimeout(hiddenTimer);
      if (document.hidden) hiddenTimer = window.setTimeout(disconnect, HIDDEN_MS);
      else connect();
    };
    connect();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      clearTimeout(hiddenTimer);
      disconnect();
      // Nothing left pending or scheduled: a remount (or a new source) starts clean.
      if (frame.current) {
        cancelAnimationFrame(frame.current);
        clearTimeout(frame.current);
        frame.current = 0;
      }
      pending.current = { items: [], jobs: new Map(), opening: null, state: null };
    };
  }, [source]);

  return feed;
}

/**
 * The server's stream of an account. The browser's EventSource reconnects on
 * its own after each stream's lifetime and after network trouble, resuming
 * after the last item; when the server turns it away (signed out, too many
 * open) it's tried again after a growing pause, up to a minute.
 */
export function serverFeed(orgId: string): FeedSource {
  return {
    open(after, on) {
      let source: EventSource | null = null;
      let retry = 0;
      let wait = 0;
      let stopped = false;
      const start = () => {
        if (stopped) return;
        on.state("connecting");
        source = new EventSource(`/api/hackers/${orgId}/live${after !== null ? `?after=${after}` : ""}`);
        source.addEventListener("opening", (event) => {
          retry = 0;
          on.state("live");
          on.opening(JSON.parse((event as MessageEvent<string>).data));
        });
        source.addEventListener("item", (event) => {
          const item = JSON.parse((event as MessageEvent<string>).data) as FeedItem;
          if (after === null || item.at > after) after = item.at;
          on.item(item);
        });
        source.addEventListener("job", (event) => on.job(JSON.parse((event as MessageEvent<string>).data)));
        source.onerror = () => {
          if (source?.readyState === EventSource.CONNECTING) return on.state("connecting");
          // Closed for good (turned away): try again later.
          on.state("offline");
          source?.close();
          wait = window.setTimeout(start, Math.min(60_000, 2_000 * 2 ** retry++));
        };
      };
      start();
      return () => {
        stopped = true;
        clearTimeout(wait);
        source?.close();
      };
    },
  };
}
