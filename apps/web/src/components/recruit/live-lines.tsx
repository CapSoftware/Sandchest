"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { LiveStats } from "@/server/stats";

/** How long the server shows one reading of the totals (STATS_TTL_S), and so how long the count has to climb to it. */
const WINDOW_MS = 10 * 60_000;

/** How often to look for a new reading: a cheap hit on the CDN's copy. */
const POLL_MS = 2 * 60_000;

/** How far below the real total the count starts, so it has somewhere to climb: about 1%. */
const behind = (total: number) => Math.round(Math.min(500_000, Math.max(10_000, total * 0.01)));

/** The gap between steps: uneven, about 2.4 seconds on average. */
const pause = () => 1_200 + Math.random() * 2_400;
const MEAN_PAUSE = 2_400;

/**
 * How big one chunk is, as a share of an average chunk, shaped like the
 * work that adds lines: mostly pull request reviews, sometimes a deep scan
 * of a repository, now and then a large one. Averages 1.
 */
function share(): number {
  const r = Math.random();
  const between = (low: number, high: number) => low + Math.random() * (high - low);
  if (r < 0.8) return between(0.03, 0.5);
  if (r < 0.98) return between(1, 5);
  return between(8, 18);
}

/**
 * Every line of code Sandchest has read, counting up as scans finish, and
 * how many are running right now: one number, as large as the empty side
 * of the screen allows, in the landing's pixel gold with a dithered
 * extrusion. The server reads the real totals every ten minutes; the count
 * starts a little behind and climbs to each new total in random chunks over
 * those ten minutes, so it moves like the work, and never passes it.
 *
 * Static pages pass no `initial`: the first reading is fetched at once, and
 * the counter keeps its space, unseen, until it arrives. `className` places
 * it: beside the onboarding panel by default.
 */
export function LiveLines({ initial, hidden = false, className = "onboard-live" }: { initial?: LiveStats; hidden?: boolean; className?: string }) {
  const [stats, setStats] = useState<LiveStats | null>(initial ?? null);
  const [shown, setShown] = useState(() => (initial ? Math.max(0, initial.lines - behind(initial.lines)) : 0));
  // A static page's reading never came: give the space back.
  const [failed, setFailed] = useState(false);
  // The total being climbed to, and when the climb should arrive. A reading from a server instance that is behind never pulls it back.
  const goal = useRef({ lines: initial?.lines ?? 0, by: Date.now() + WINDOW_MS });
  const first = useRef(!initial);

  useEffect(() => {
    let alive = true;
    const read = () =>
      fetch("/api/stats")
        .then((response) => (response.ok ? (response.json() as Promise<LiveStats>) : null))
        .then((next) => {
          if (!alive) return;
          if (!next || typeof next.lines !== "number") throw new Error("no reading");
          if (first.current) {
            first.current = false;
            setShown(Math.max(0, next.lines - behind(next.lines)));
          }
          if (next.lines > goal.current.lines) goal.current = { lines: next.lines, by: Date.now() + WINDOW_MS };
          setStats((now) => ({ lines: Math.max(now?.lines ?? 0, next.lines), running: next.running }));
        })
        .catch(() => {
          if (alive && first.current) setFailed(true);
        });
    if (first.current) read();
    const timer = setInterval(() => document.visibilityState === "visible" && read(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  // Each step adds a random chunk, sized so the climb lands on the total at about the time the next one arrives.
  // Without motion, it shows the total as it is.
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      const { lines, by } = goal.current;
      setShown((now) => {
        if (now >= lines) return now;
        const steps = Math.max(4, (by - Date.now()) / MEAN_PAUSE);
        return Math.min(lines, now + Math.max(1, Math.round(((lines - now) / steps) * share())));
      });
      timer = setTimeout(step, pause());
    };
    timer = setTimeout(step, 900);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (stats && matchMedia("(prefers-reduced-motion: reduce)").matches) setShown(stats.lines);
  }, [stats]);

  if (failed || stats?.lines === 0) return null;
  // Until the first reading, a stand-in of about the right width holds the space.
  const text = stats ? shown.toLocaleString("en-US") : "000,000,000";
  // How wide the number is in ems of the pixel face (a digit is 0.375em, a comma 0.16em), so the CSS can size it
  // to fill the space beside the panel exactly.
  const ems = [...text].reduce((sum, ch) => sum + (ch === "," ? 0.16 : 0.375), 0);
  return (
    <aside className={`live-lines ${className}`} data-hidden={hidden || undefined} data-pending={stats ? undefined : ""} aria-label="Sandchest right now" style={{ "--ems": ems } as CSSProperties}>
      <p className="live-lines-count" data-n={text}>
        {text}
      </p>
      <p className="live-lines-label">lines of code scanned by Sandchest</p>
      {stats && stats.running > 0 && (
        <p className="live-lines-running">
          <span className="live-lines-dot" aria-hidden="true" />
          {stats.running === 1 ? "1 scan running now" : `${stats.running.toLocaleString("en-US")} scans running now`}
        </p>
      )}
    </aside>
  );
}
