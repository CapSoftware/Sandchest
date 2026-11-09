"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useFirstPress, useWaking } from "./first-press";

/**
 * The station's tracks, in /public/radio: a few minutes each, cut from one long
 * mix at its own quiet points. Browsers keep them for a year (next.config.ts),
 * so bump the version when a track changes.
 */
const RADIO_VERSION = "3";
const TRACKS = Array.from({ length: 10 }, (_, i) => `/radio/${String(i + 1).padStart(2, "0")}.webm?v=${RADIO_VERSION}`);
/** How loud the radio plays at full on its slider. */
const VOLUME = 0.55;
const LEVEL_KEY = "sandchest:radio-level";
/** "1" while it's on, so it comes back on next time. */
const ON_KEY = "sandchest:radio-on";
const FADE_MS = 400;

export interface Radio {
  /** Whether this browser plays the tracks; the keys stay hidden if not. */
  supported: boolean;
  on: boolean;
  /** On, but the browser wants a press on the page before it will play (it was left on last time). */
  waiting: boolean;
  /** Never switched on or off on this browser: nothing chosen yet. */
  untouched: boolean;
  /** Which track is on, counting from 1. */
  track: number | null;
  toggle: () => void;
  next: () => void;
  /** Starts fetching the first track, so it plays the moment it's asked for (the Sound menu opening is a good sign it will be). */
  prime: () => void;
  /** Its slider, 0 to 1, remembered on this browser. */
  level: number;
  setLevel: (level: number) => void;
}

/**
 * Background music for the hacker's room, off until asked for. Left on, it
 * comes back on next visit: at once where the browser allows, or on the
 * first press anywhere on the page. Track 1 always opens the station; the rest follow in a shuffled order, every one once before
 * any repeats, and never the same one twice running. Only the track playing is
 * fetched, and it streams.
 */
export function useRadio(): Radio {
  const [supported, setSupported] = useState(false);
  const [on, setOn] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [untouched, setUntouched] = useState(false);
  const waking = useWaking();
  const [track, setTrack] = useState<number | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const queue = useRef<number[]>([]);
  const fade = useRef(0);
  const [level, setLevelState] = useState(0.8);
  const levelRef = useRef(0.8);

  useEffect(() => {
    setSupported(document.createElement("audio").canPlayType('audio/webm; codecs="opus"') !== "");
    setUntouched(safeGet(ON_KEY) === null);
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
    return el.play();
  }, [track]);

  // Kept current for the `ended` listener, which outlives any one render.
  const playRef = useRef(play);
  playRef.current = play;

  const element = useCallback(() => {
    if (audio.current) return audio.current;
    const el = new Audio();
    el.preload = "none";
    el.addEventListener("ended", () => void playRef.current(el).catch(() => setOn(false)));
    el.addEventListener("error", () => setOn(false));
    audio.current = el;
    return el;
  }, []);

  const prime = useCallback(() => {
    const el = element();
    if (el.src || track !== null) return;
    el.preload = "auto";
    el.src = TRACKS[0]!;
  }, [element, track]);

  /**
   * Plays, fading in. A browser that wants a press first (sound left on from
   * last time) leaves it on and waiting; any other failure turns it off.
   */
  const start = useCallback(
    (el: HTMLAudioElement, playing: Promise<void>) => {
      el.volume = 0;
      playing.then(
        () => {
          setWaiting(false);
          ramp(el, VOLUME * levelRef.current);
        },
        (error: unknown) => {
          if (error instanceof DOMException && error.name === "NotAllowedError") setWaiting(true);
          else if (!(error instanceof DOMException && error.name === "AbortError")) setOn(false);
        },
      );
    },
    [ramp],
  );

  const turnOn = useCallback(() => {
    const el = element();
    setOn(true);
    setUntouched(false);
    remember(ON_KEY, "1");
    el.volume = 0;
    // Primed with the first track but never played: play that, from what's already in.
    if (el.src && track === null && queue.current.length === 0) {
      queue.current = shuffled(TRACKS.length - 1, null).map((i) => i + 1);
      setTrack(1);
      start(el, el.play());
    } else if (el.src && !el.ended) start(el, el.play());
    else start(el, play(el));
  }, [element, play, start, track]);

  const toggle = useCallback(() => {
    // The key press that just woke it was asking for music, not to switch it off.
    if (waking.now()) return;
    if (!on) return turnOn();
    const el = element();
    setOn(false);
    setWaiting(false);
    setUntouched(false);
    remember(ON_KEY, "0");
    ramp(el, 0, () => el.pause());
  }, [element, on, ramp, turnOn, waking]);

  // Left on last time: on again, playing as soon as the browser lets it.
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current || !supported || safeGet(ON_KEY) !== "1") return;
    resumed.current = true;
    turnOn();
  }, [supported, turnOn]);
  // Unmounted (and, in development, mounted again at once): free to start it again.
  useEffect(
    () => () => {
      resumed.current = false;
    },
    [],
  );

  // Waiting on the browser: the first press anywhere starts it.
  useFirstPress(on && waiting, (event) => {
    if (event.type === "keydown") waking.mark();
    const el = audio.current;
    if (el?.src && el.paused) start(el, el.play());
  });

  const next = useCallback(() => {
    const el = element();
    el.volume = VOLUME * levelRef.current;
    play(el).catch(() => setOn(false));
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

  return { supported, on, waiting, untouched, track, toggle, next, prime, level, setLevel };
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered, then.
  }
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
