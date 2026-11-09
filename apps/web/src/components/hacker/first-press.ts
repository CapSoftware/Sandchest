"use client";
import { useEffect, useRef } from "react";

/** The presses a browser counts as the visitor asking for something, after which a page may play sound. */
const PRESSES = ["pointerdown", "pointerup", "mousedown", "keydown", "touchend", "click"] as const;

/**
 * While `waiting`, calls `press` on every press anywhere on the page (a
 * click, a tap, a key; Escape doesn't count), before the page's own
 * handlers see it. For sound that was left on: browsers only start it after
 * a press, so it starts on the first one. `press` should stop the waiting
 * once the sound is really playing.
 */
export function useFirstPress(waiting: boolean, press: (event: Event) => void): void {
  const latest = useRef(press);
  latest.current = press;
  useEffect(() => {
    if (!waiting) return;
    const handle = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key === "Escape") return;
      latest.current(event);
    };
    for (const name of PRESSES) window.addEventListener(name, handle, { capture: true });
    return () => {
      for (const name of PRESSES) window.removeEventListener(name, handle, { capture: true });
    };
  }, [waiting]);
}

/**
 * Marks the moment a key press woke the sound, until the page's own handlers
 * for that same press have run: so R or K, pressed to get the sound going,
 * doesn't also switch it straight off again. (A click on the menu's Off is a
 * press of its own, after the one that woke it, so it still works.)
 */
export function useWaking(): { mark: () => void; now: () => boolean } {
  const waking = useRef(false);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  return useRef({
    mark: () => {
      waking.current = true;
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => (waking.current = false), 0);
    },
    now: () => waking.current,
  }).current;
}
