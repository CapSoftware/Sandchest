"use client";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Signals } from "@/components/rig/signals";
import { keyboardSound, SWITCHES, type KeyboardSound, type SwitchId } from "./switches";

const STYLE_KEY = "sandchest:keyboard-sound";
const LEVEL_KEY = "sandchest:keyboard-level";

export interface KeySounds {
  /** Whether this browser can make the sound; its choices stay hidden if not. */
  supported: boolean;
  on: boolean;
  style: SwitchId;
  toggle: () => void;
  /** Turns it on with `style`, playing a key so it can be heard at once. */
  choose: (style: SwitchId) => void;
  /** Its slider, 0 to 1, remembered on this browser. */
  level: number;
  setLevel: (level: number) => void;
}

/**
 * The sound of the hacker's keyboard as they type, off until asked for (and
 * always off on a new visit: browsers only play sound after a press). The
 * keyboard chosen is remembered on this browser. It listens to the rig
 * through `signals`, so each key sounds on the frame it's drawn going down.
 */
export function useKeySounds(signals: RefObject<Signals>): KeySounds {
  const [supported, setSupported] = useState(false);
  const [on, setOn] = useState(false);
  const [style, setStyle] = useState<SwitchId>("thock");
  const sound = useRef<KeyboardSound | null>(null);
  const [level, setLevelState] = useState(0.8);
  const levelRef = useRef(0.8);

  useEffect(() => {
    setSupported(typeof window.AudioContext === "function" || "webkitAudioContext" in window);
    try {
      const saved = localStorage.getItem(STYLE_KEY);
      if (SWITCHES.some((s) => s.id === saved)) setStyle(saved as SwitchId);
      const loud = localStorage.getItem(LEVEL_KEY);
      if (loud !== null && Number(loud) >= 0 && Number(loud) <= 1) {
        levelRef.current = Number(loud);
        setLevelState(Number(loud));
      }
    } catch {
      // Storage blocked: the default keyboard it is.
    }
  }, []);

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
    sound.current.resume();
    setOn(true);
    return true;
  }, []);

  const toggle = useCallback(() => {
    if (!on) return void start(style);
    sound.current?.suspend();
    setOn(false);
  }, [on, start, style]);

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

  return { supported, on, style, toggle, choose, level, setLevel };
}
