"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Keycap } from "./keycap";

/**
 * The station's tracks, in /public/radio: a few minutes each, cut from one long
 * mix at its own quiet points. Browsers keep them for a year (next.config.ts),
 * so bump the version when a track changes.
 */
const RADIO_VERSION = "2";
const TRACKS = Array.from({ length: 10 }, (_, i) => `/radio/${String(i + 1).padStart(2, "0")}.webm?v=${RADIO_VERSION}`);
const VOLUME = 0.55;
const FADE_MS = 400;

export interface Radio {
  /** Whether this browser plays the tracks; the keys stay hidden if not. */
  supported: boolean;
  on: boolean;
  /** Which track is on, counting from 1. */
  track: number | null;
  toggle: () => void;
  next: () => void;
}

/**
 * Background music for the hacker's room, off until asked for. Track 1 always
 * opens the station; the rest follow in a shuffled order, every one once before
 * any repeats, and never the same one twice running. Only the track playing is
 * fetched, and it streams.
 */
export function useRadio(): Radio {
  const [supported, setSupported] = useState(false);
  const [on, setOn] = useState(false);
  const [track, setTrack] = useState<number | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const queue = useRef<number[]>([]);
  const fade = useRef(0);

  useEffect(() => {
    setSupported(document.createElement("audio").canPlayType('audio/webm; codecs="opus"') !== "");
  }, []);

  const ramp = useCallback((el: HTMLAudioElement, to: number, done?: () => void) => {
    cancelAnimationFrame(fade.current);
    const from = el.volume;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / FADE_MS);
      el.volume = from + (to - from) * t;
      if (t < 1) fade.current = requestAnimationFrame(step);
      else done?.();
    };
    fade.current = requestAnimationFrame(step);
  }, []);

  const play = useCallback((el: HTMLAudioElement) => {
    if (queue.current.length === 0) queue.current = track === null ? [0, ...shuffled(TRACKS.length - 1, null).map((i) => i + 1)] : shuffled(TRACKS.length, track - 1);
    const index = queue.current.shift()!;
    el.src = TRACKS[index]!;
    setTrack(index + 1);
    el.play().catch(() => setOn(false));
  }, [track]);

  // Kept current for the `ended` listener, which outlives any one render.
  const playRef = useRef(play);
  playRef.current = play;

  const element = useCallback(() => {
    if (audio.current) return audio.current;
    const el = new Audio();
    el.preload = "none";
    el.addEventListener("ended", () => playRef.current(el));
    el.addEventListener("error", () => setOn(false));
    audio.current = el;
    return el;
  }, []);

  const toggle = useCallback(() => {
    const el = element();
    if (on) {
      setOn(false);
      ramp(el, 0, () => el.pause());
      return;
    }
    setOn(true);
    el.volume = 0;
    if (el.src && !el.ended) el.play().catch(() => setOn(false));
    else play(el);
    ramp(el, VOLUME);
  }, [element, on, play, ramp]);

  const next = useCallback(() => {
    const el = element();
    el.volume = VOLUME;
    play(el);
  }, [element, play]);

  // Leaving the page stops the music and lets the browser drop the stream.
  useEffect(
    () => () => {
      cancelAnimationFrame(fade.current);
      const el = audio.current;
      if (!el) return;
      el.pause();
      el.removeAttribute("src");
      el.load();
    },
    [],
  );

  return { supported, on, track, toggle, next };
}

/** A shuffled order of every track, not starting on `last` so a new round never repeats the one just played. */
function shuffled(count: number, last: number | null): number[] {
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  if (count > 1 && order[0] === last) [order[0], order[1]] = [order[1]!, order[0]!];
  return order;
}

/** The radio's keys on the hacker's card: on and off, and a skip while it plays. */
export function RadioKeys({ radio }: { radio: Radio }) {
  if (!radio.supported) return null;
  return (
    <div className="hq-radio" role="group" aria-label="Radio">
      <button type="button" className="cap-key" aria-pressed={radio.on} onClick={radio.toggle} data-track="hacker-radio-toggle">
        <span className="cap-key-face">
          <RadioBars on={radio.on} />
          {radio.on && radio.track ? `Radio · ${String(radio.track).padStart(2, "0")}` : "Radio"} <Keycap>R</Keycap>
        </span>
      </button>
      {radio.on && (
        <button type="button" className="cap-key cap-key-icon" onClick={radio.next} aria-label="Next track" data-track="hacker-radio-next">
          <span className="cap-key-face">
            <SkipIcon />
          </span>
        </button>
      )}
    </div>
  );
}

/** Three pixel bars: still when off, bouncing like a level meter when on. */
function RadioBars({ on }: { on: boolean }) {
  return (
    <span className="hq-radio-bars" data-on={on || undefined} aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

function SkipIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 7 7" shapeRendering="crispEdges" aria-hidden="true">
      <path fill="currentColor" d="M0 0h1v7H0zM1 1h1v5H1zM2 2h1v3H2zM3 3h1v1H3zM5 0h2v7H5z" />
    </svg>
  );
}
