"use client";
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import type { KeySounds } from "./key-sounds";
import { Keycap } from "./keycap";
import type { Radio } from "./radio";
import { SWITCHES } from "./switches";
import "./sound-menu.css";

/**
 * Everything the room can play, behind one key: the radio, and the sound of
 * the keyboard as the hacker types, with a choice of keyboards. The first
 * time it's pressed on a browser it turns both on; what's chosen from then
 * on is remembered. The panel
 * opens above the key (`up`, for keys at the foot of a picture) or below it.
 */
export function SoundMenu({ radio, keys, up, small }: { radio: Radio; keys: KeySounds; up?: boolean; small?: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useId();

  // Closes on a press anywhere else, or Esc (back to the key).
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  if (!radio.supported && !keys.supported) return null;
  const playing = (radio.on && radio.supported) || keys.on;
  // Left on last time, and the browser wants a press before it plays: say so, where the sound is.
  const waiting = (radio.supported && radio.on && radio.waiting) || (keys.on && keys.waiting);
  return (
    <div ref={box} className="sound" data-up={up || undefined}>
      <button
        ref={button}
        type="button"
        className={`cap-key${small ? " cap-key-small" : ""}`}
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => {
          // Nothing chosen yet on this browser: asking for sound means all of it, the radio and the keys. After that the menu only opens.
          const first = !open && (radio.supported || keys.supported) && (!radio.supported || radio.untouched) && (!keys.supported || keys.untouched);
          if (first) {
            if (radio.supported && !radio.on) radio.toggle();
            if (keys.supported && !keys.on) keys.toggle();
          } else if (!open && radio.supported && !radio.on) radio.prime();
          setOpen((o) => !o);
        }}
        onPointerEnter={() => radio.supported && !radio.on && radio.prime()}
        data-track="hacker-sound-open"
      >
        <span className="cap-key-face">
          <SpeakerIcon on={playing && !waiting} />
          <span className="cap-key-label">{waiting ? <WaitingLabel /> : "Sound"}</span>
        </span>
      </button>
      {open && (
        <div id={panel} className="sound-panel" role="group" aria-label="Sound">
          {radio.supported && (
            <div className="sound-row">
              <span className="sound-name">
                Radio{radio.on && radio.track ? <span className="sound-note">track {String(radio.track).padStart(2, "0")}</span> : null} <Keycap>R</Keycap>
              </span>
              <span className="sound-choices" role="radiogroup" aria-label="Radio">
                <button type="button" role="radio" className="sound-choice" aria-checked={!radio.on} onClick={() => radio.on && radio.toggle()} data-track="hacker-radio-off">
                  Off
                </button>
                <button type="button" role="radio" className="sound-choice" aria-checked={radio.on} onClick={() => !radio.on && radio.toggle()} data-track="hacker-radio-toggle">
                  On
                </button>
                <button type="button" className="sound-choice sound-icon" onClick={radio.next} disabled={!radio.on} aria-label="Next track" data-track="hacker-radio-next">
                  <SkipIcon /> Next
                </button>
              </span>
              <Level label="Radio volume" value={radio.level} onChange={radio.setLevel} />
            </div>
          )}
          {keys.supported && (
            <div className="sound-row">
              <span className="sound-name">
                Keyboard <Keycap>K</Keycap>
              </span>
              <span className="sound-choices" role="radiogroup" aria-label="Keyboard sound">
                <button type="button" role="radio" className="sound-choice" aria-checked={!keys.on} onClick={() => keys.on && keys.toggle()} data-track="hacker-keys-off">
                  Off
                </button>
                {SWITCHES.map((s) => (
                  <button key={s.id} type="button" role="radio" className="sound-choice" aria-checked={keys.on && keys.style === s.id} onClick={() => keys.choose(s.id)} data-track={`hacker-keys-${s.id}`}>
                    {s.label}
                  </button>
                ))}
              </span>
              <Level label="Keyboard volume" value={keys.level} onChange={keys.setLevel} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** "Click for sound", or "Tap for sound" on a touch screen. */
function WaitingLabel() {
  const [touch] = useState(() => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches);
  return <>{touch ? "Tap" : "Click"} for sound</>;
}

/** A volume slider, in the room's colours: quiet on the left, loud on the right. */
function Level({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <span className="sound-level">
      <QuietIcon />
      <input type="range" min={0} max={1} step={0.01} value={value} aria-label={label} onChange={(event) => onChange(Number(event.currentTarget.value))} style={{ "--level": `${value * 100}%` } as CSSProperties} />
      <LoudIcon />
    </span>
  );
}

function QuietIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 7 7" shapeRendering="crispEdges" aria-hidden="true">
      <path fill="currentColor" d="M0 2h2v3H0zM2 1h1v5H2zM3 0h1v7H3z" />
    </svg>
  );
}

function LoudIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 7 7" shapeRendering="crispEdges" aria-hidden="true">
      <path fill="currentColor" d="M0 2h2v3H0zM2 1h1v5H2zM3 0h1v7H3zM5 2h1v3H5zM6 0h1v1H6zM6 6h1v1H6z" />
    </svg>
  );
}

/** A pixel speaker: quiet when nothing plays, sound coming off it when something does. */
function SpeakerIcon({ on }: { on: boolean }) {
  return (
    <svg className="sound-speaker" data-on={on || undefined} width="14" height="14" viewBox="0 0 7 7" shapeRendering="crispEdges" aria-hidden="true">
      <path fill="currentColor" d="M0 2h2v3H0zM2 1h1v5H2zM3 0h1v7H3z" />
      {on && <path className="sound-waves" fill="currentColor" d="M5 2h1v3H5zM6 0h1v1H6zM6 6h1v1H6z" />}
    </svg>
  );
}

function SkipIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 7 7" shapeRendering="crispEdges" aria-hidden="true">
      <path fill="currentColor" d="M0 0h1v7H0zM1 1h1v5H1zM2 2h1v3H2zM3 3h1v1H3zM5 0h2v7H5z" />
    </svg>
  );
}
