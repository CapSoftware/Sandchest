"use client";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Signals } from "@/components/rig/signals";
import { useFirstPress, useWaking } from "./first-press";
import { keyboardSound, SWITCHES, type KeyboardSound, type SwitchId } from "./switches";

const STYLE_KEY = "sandchest:keyboard-sound";
const LEVEL_KEY = "sandchest:keyboard-level";
/** "1" while it's on, so it comes back on next time. */
const ON_KEY = "sandchest:keyboard-on";

export interface KeySounds {
  /** Whether this browser can make the sound; its choices stay hidden if not. */
  supported: boolean;
  on: boolean;
  /** On, but the browser wants a press on the page before it will play (it was left on last time). */
  waiting: boolean;
  style: SwitchId;
  toggle: () => void;
  /** Turns it on with `style`, playing a key so it can be heard at once. */
  choose: (style: SwitchId) => void;
  /** Its slider, 0 to 1, remembered on this browser. */
  level: number;
  setLevel: (level: number) => void;
}

/**
 * The sound of the hacker's keyboard as they type, off until asked for. Left
 * on, it comes back on next visit: at once where the browser allows, or on
 * the first press anywhere on the page (browsers only play sound after one).
 * The keyboard chosen and its level are remembered on this browser too. It
 * listens to the rig through `signals`, so each key sounds on the frame it's
 * drawn going down.
 */
export function useKeySounds(signals: RefObject<Signals>): KeySounds {
  const [supported, setSupported] = useState(false);
  const [on, setOn] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const waking = useWaking();
  const [style, setStyle] = useState<SwitchId>("thock");
  const sound = useRef<KeyboardSound | null>(null);
  const [level, setLevelState] = useState(0.8);
  const levelRef = useRef(0.8);

  useEffect(() => {
    const can = typeof window.AudioContext === "function" || "webkitAudioContext" in window;
    setSupported(can);
    let chosen: SwitchId = "thock";
    let again = false;
    try {
      const saved = localStorage.getItem(STYLE_KEY);
      if (SWITCHES.some((s) => s.id === saved)) chosen = saved as SwitchId;
      const loud = localStorage.getItem(LEVEL_KEY);
      if (loud !== null && Number(loud) >= 0 && Number(loud) <= 1) {
        levelRef.current = Number(loud);
        setLevelState(Number(loud));
      }
      again = localStorage.getItem(ON_KEY) === "1";
    } catch {
      // Storage blocked: the default keyboard it is, off.
    }
    setStyle(chosen);
    if (!can || !again) return;
    // Left on last time: on again, sounding as soon as the browser lets it.
    sound.current ??= keyboardSound(chosen);
    if (!sound.current) return;
    sound.current.level = levelRef.current;
    setOn(true);
    if (sound.current.running) return;
    setWaiting(true);
    void sound.current.resume().then(() => setWaiting(false));
  }, []);

  // Waiting on the browser: the first press anywhere wakes it.
  useFirstPress(on && waiting, (event) => {
    if (event.type === "keydown") waking.mark();
    void sound.current?.resume().then(() => setWaiting(false));
  });

  // Listen to the keys only while on.
  useEffect(() => {
    const s = signals.current;
    if (!s || !on) return;
    s.onKey = (key, down) => {
      if (down) sound.current?.play(key);
    };
    return () => {
      s.onKey = undefined;
    };
  }, [on, signals]);

  /** On, with `chosen`: made on the press itself, which is what lets the browser play it. */
  const start = useCallback((chosen: SwitchId) => {
    sound.current ??= keyboardSound(chosen);
    if (!sound.current) return false;
    sound.current.switch = chosen;
    sound.current.level = levelRef.current;
    void sound.current.resume().then(() => setWaiting(false));
    setOn(true);
    remember(ON_KEY, "1");
    return true;
  }, []);

  const toggle = useCallback(() => {
    // The key press that just woke it was asking for sound, not to switch it off.
    if (waking.now()) return;
    if (!on) return void start(style);
    sound.current?.suspend();
    setOn(false);
    setWaiting(false);
    remember(ON_KEY, "0");
  }, [on, start, style, waking]);

  const choose = useCallback(
    (chosen: SwitchId) => {
      setStyle(chosen);
      try {
        localStorage.setItem(STYLE_KEY, chosen);
      } catch {
        // Not remembered, then.
      }
      if (!start(chosen)) return;
      // A taste of it: a key, as a person would try one.
      void sound.current?.load(chosen).then(() => sound.current?.play(40));
    },
    [start],
  );

  const setLevel = useCallback((next: number) => {
    const value = Math.max(0, Math.min(1, next));
    levelRef.current = value;
    setLevelState(value);
    if (sound.current) sound.current.level = value;
    try {
      localStorage.setItem(LEVEL_KEY, String(value));
    } catch {
      // Not remembered, then.
    }
  }, []);

  // Leaving the page stops the sound for good.
  useEffect(
    () => () => {
      sound.current?.close();
      sound.current = null;
    },
    [],
  );

  return { supported, on, waiting, style, toggle, choose, level, setLevel };
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered, then.
  }
}
