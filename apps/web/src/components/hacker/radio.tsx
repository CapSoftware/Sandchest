"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The station's tracks, in /public/radio: a few minutes each, cut from one long
 * mix at its own quiet points. Browsers keep them for a year (next.config.ts),
 * so bump the version when a track changes.
 */
const RADIO_VERSION = "2";
const TRACKS = Array.from({ length: 10 }, (_, i) => `/radio/${String(i + 1).padStart(2, "0")}.webm?v=${RADIO_VERSION}`);
/** How loud the radio plays at full on its slider. */
const VOLUME = 0.55;
const LEVEL_KEY = "sandchest:radio-level";
const FADE_MS = 400;

export interface Radio {
  /** Whether this browser plays the tracks; the keys stay hidden if not. */
  supported: boolean;
  on: boolean;
  /** Which track is on, counting from 1. */
  track: number | null;
  toggle: () => void;
  next: () => void;
  /** Its slider, 0 to 1, remembered on this browser. */
  level: number;
  setLevel: (level: number) => void;
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
  const [level, setLevelState] = useState(0.8);
  const levelRef = useRef(0.8);

  useEffect(() => {
    setSupported(document.createElement("audio").canPlayType('audio/webm; codecs="opus"') !== "");
    const saved = Number(safeGet(LEVEL_KEY));
    if (saved >= 0 && saved <= 1 && safeGet(LEVEL_KEY) !== null) {
      levelRef.current = saved;
      setLevelState(saved);
    }
  }, []);

  const setLevel = useCallback((next: number) => {
    const value = Math.max(0, Math.min(1, next));
    levelRef.current = value;
    setLevelState(value);
    cancelAnimationFrame(fade.current);
    if (audio.current && !audio.current.paused) audio.current.volume = VOLUME * value;
    try {
      localStorage.setItem(LEVEL_KEY, String(value));
    } catch {
      // Not remembered, then.
    }
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
    ramp(el, VOLUME * levelRef.current);
  }, [element, on, play, ramp]);

  const next = useCallback(() => {
    const el = element();
    el.volume = VOLUME * levelRef.current;
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

  return { supported, on, track, toggle, next, level, setLevel };
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
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
