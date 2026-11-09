"use client";
import { useCallback, useEffect, useState, type RefObject } from "react";
import { Keycap } from "./keycap";

/** How long the controls, and the pointer, stay after the last sign of someone there. */
const IDLE_MS = 2500;
/** Leaving the room (the pointer off the window): gone sooner. */
const LEFT_MS = 400;

export interface Idle {
  /** The words and controls step aside. */
  idle: boolean;
  /** The pointer hides. */
  still: boolean;
}

/**
 * The room left to itself: a few seconds after the last move, tap or scroll
 * the pointer hides (`still`), and a few seconds after the last move or key
 * the words and controls fade (`idle`). Moving brings both back; a key brings
 * back the controls only, as a video player does. Not while `active` is false
 * (customizing). The controls stay only while a menu is open, or while someone
 * is tabbing through them: a pointer resting on one, or a button left focused
 * by a click, doesn't hold them.
 */
export function useIdle(stage: RefObject<HTMLElement | null>, active: boolean): Idle {
  const [idle, setIdle] = useState(false);
  const [still, setStill] = useState(false);
  useEffect(() => {
    const el = stage.current;
    if (!active || !el) {
      setIdle(false);
      setStill(false);
      return;
    }
    let controls = 0;
    let pointer = 0;
    // Whether the last thing done was Tab (moving through the controls by keyboard), not a click.
    let tabbing = false;
    const busy = () => !!el.querySelector(".sound-panel") || (tabbing && !!el.querySelector(".hq-top :focus-visible, .hq-drawer :focus-visible"));
    const fade = (ms: number) => {
      clearTimeout(controls);
      controls = window.setTimeout(function check() {
        if (busy()) controls = window.setTimeout(check, IDLE_MS);
        else setIdle(true);
      }, ms);
    };
    const moved = (event: Event) => {
      if (event.type === "pointerdown") tabbing = false;
      setIdle(false);
      setStill(false);
      fade(IDLE_MS);
      clearTimeout(pointer);
      pointer = window.setTimeout(() => setStill(true), IDLE_MS);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Tab") tabbing = true;
      setIdle(false);
      fade(IDLE_MS);
    };
    const left = () => fade(LEFT_MS);
    const moves = ["pointermove", "pointerdown", "wheel", "touchstart"] as const;
    for (const name of moves) el.addEventListener(name, moved, { passive: true });
    el.addEventListener("pointerleave", left);
    window.addEventListener("keydown", key);
    // Up to begin with, so they can be found, then away.
    setIdle(false);
    fade(IDLE_MS);
    pointer = window.setTimeout(() => setStill(true), IDLE_MS);
    return () => {
      clearTimeout(controls);
      clearTimeout(pointer);
      for (const name of moves) el.removeEventListener(name, moved);
      el.removeEventListener("pointerleave", left);
      window.removeEventListener("keydown", key);
    };
  }, [stage, active]);
  return { idle, still };
}

type Prefixed = Document & { webkitFullscreenEnabled?: boolean; webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };
type PrefixedElement = HTMLElement & { webkitRequestFullscreen?: () => void };

export interface Fullscreen {
  /** Whether this browser can show the room full screen (most phones can't). */
  supported: boolean;
  on: boolean;
  toggle: () => void;
}

/** The room alone on the screen, nothing of the page or the browser around it. Esc (the browser's own) leaves. */
export function useFullscreen(stage: RefObject<HTMLElement | null>): Fullscreen {
  const [supported, setSupported] = useState(false);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const doc = document as Prefixed;
    setSupported(!!(doc.fullscreenEnabled || doc.webkitFullscreenEnabled));
    const sync = () => setOn(!!stage.current && (doc.fullscreenElement ?? doc.webkitFullscreenElement) === stage.current);
    sync();
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, [stage]);
  const toggle = useCallback(() => {
    const doc = document as Prefixed;
    const el = stage.current as PrefixedElement | null;
    if (!el) return;
    if (doc.fullscreenElement ?? doc.webkitFullscreenElement) {
      if (doc.exitFullscreen) void doc.exitFullscreen().catch(() => {});
      else doc.webkitExitFullscreen?.();
    } else if (el.requestFullscreen) void el.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
    else el.webkitRequestFullscreen?.();
  }, [stage]);
  return { supported, on, toggle };
}

/** The full screen key: four corners out, or in to leave. */
export function FullscreenKey({ fullscreen }: { fullscreen: Fullscreen }) {
  if (!fullscreen.supported) return null;
  const label = fullscreen.on ? "Leave full screen" : "Full screen";
  return (
    <button type="button" className="cap-key" onClick={fullscreen.toggle} aria-label={label} title={label} data-track={fullscreen.on ? "hacker-fullscreen-leave" : "hacker-fullscreen"}>
      <span className="cap-key-face">
        <FullscreenIcon on={fullscreen.on} /> <Keycap>F</Keycap>
      </span>
    </button>
  );
}

function FullscreenIcon({ on }: { on: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 7 7" shapeRendering="crispEdges" aria-hidden="true">
      <path fill="currentColor" d={on ? "M2 0h1v3H0V2h2zM4 0h1v2h2v1H4zM0 4h3v3H2V5H0zM4 4h3v1H5v2H4z" : "M0 0h3v1H1v2H0zM4 0h3v3H6V1H4zM0 4h1v2h2v1H0zM6 4h1v3H4V6h2z"} />
    </svg>
  );
}
