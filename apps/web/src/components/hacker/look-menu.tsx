"use client";
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from "react";
import { loadFonts, pageFonts, stickerDataUrl } from "@/components/rig/art";
import type { ShotName } from "@/components/rig/shots";
import { aside, HOODIES, MAX_STICKERS, PHOSPHORS, ROOMS, SHELLS, STICKERS, VOICES, type Choice, type HackerProfile } from "@/lib/hacker";

/** What can be customized, in order, and what the camera turns to for each. */
export const LOOKS = [
  { id: "hoodie", name: "Hoodie", shot: "hood" },
  { id: "shell", name: "Laptop", shot: "rig" },
  { id: "stickers", name: "Stickers", shot: "rig" },
  { id: "phosphor", name: "Screen", shot: "screen" },
  { id: "room", name: "Room", shot: "wide" },
  { id: "voice", name: "Voice", shot: "preview" },
] as const satisfies readonly { id: string; name: string; shot: ShotName }[];

/** How long the pointer rests on a line of the look menu before the camera turns to it. */
const LOOK_DWELL_MS = 220;

/**
 * The hacker's look as a game menu: one line per item, ◀ value ▶ on each,
 * the lit line's description under it. ↑↓ pick a line and ←→ change it from
 * anywhere on the page that isn't a field; the camera turns to what's lit.
 * `move` is handed out so a field above the menu can step down into it.
 */
export function LookMenu({
  profile,
  update,
  look,
  setLook,
  onTop,
  move: moveOut,
}: {
  profile: HackerProfile;
  update: (patch: Partial<HackerProfile>) => void;
  look: number;
  setLook: (at: number) => void;
  /** Up from the first line. */
  onTop?: () => void;
  move?: RefObject<((by: number) => void) | null>;
}) {
  const menu = useRef<HTMLDivElement>(null);
  // The lit line, read by the window's key listener as well as here.
  const lit = useRef(look);
  lit.current = look;
  const top = useRef(onTop);
  top.current = onTop;
  const move = (by: number) => {
    const rows = [...(menu.current?.querySelectorAll<HTMLElement>("[data-look]") ?? [])];
    const from = rows.findIndex((r) => r.contains(document.activeElement));
    const to = (from < 0 ? lit.current : from) + by;
    if (to < 0) return top.current?.();
    const row = rows[Math.min(rows.length - 1, to)];
    (row?.querySelector<HTMLInputElement>("input:checked") ?? row?.querySelector<HTMLInputElement>("input:not(:disabled)"))?.focus();
  };
  if (moveOut) moveOut.current = move;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      move(event.key === "ArrowUp" ? -1 : 1);
    }
  };
  // The arrows work from anywhere on the page, not only once a line has focus: ↑↓ pick a line, ←→ change the
  // one that's lit (by focus or by the pointer). Inside a field and on a choice, the field answers.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const vertical = event.key === "ArrowUp" || event.key === "ArrowDown";
      if (!vertical && event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const at = document.activeElement;
      if (at instanceof HTMLInputElement || at instanceof HTMLTextAreaElement || at instanceof HTMLSelectElement) return;
      event.preventDefault();
      if (vertical) return move(event.key === "ArrowUp" ? -1 : 1);
      const rows = [...(menu.current?.querySelectorAll<HTMLElement>("[data-look]") ?? [])];
      const row = rows.find((r) => r.contains(at)) ?? rows[Math.max(0, lit.current)];
      const choices = [...(row?.querySelectorAll<HTMLInputElement>("input:not(:disabled)") ?? [])];
      if (choices.length === 0) return;
      if (choices[0]!.type === "checkbox") return choices[event.key === "ArrowLeft" ? choices.length - 1 : 0]!.focus();
      const from = Math.max(0, choices.findIndex((c) => c.checked));
      const next = choices[(from + (event.key === "ArrowLeft" ? -1 : 1) + choices.length) % choices.length]!;
      next.click();
      next.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // move reads the menu and the lit line through refs, so the first one is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // The pointer has to rest on a line before the camera turns to it, so sweeping across the menu doesn't
  // send the camera around the room after every line it crosses. Focus turns it at once.
  const dwell = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(dwell.current), []);
  const row = (at: number) => ({
    "data-look": LOOKS[at]!.id,
    "data-on": look === at || undefined,
    onFocus: () => {
      clearTimeout(dwell.current);
      setLook(at);
    },
    onPointerEnter: () => {
      clearTimeout(dwell.current);
      dwell.current = setTimeout(() => setLook(at), LOOK_DWELL_MS);
    },
    onPointerLeave: () => clearTimeout(dwell.current),
  });
  const voices = VOICES.map((v) => ({ ...v, note: `“${aside(v.id, "finding", 1)}”` }));
  return (
    <>
      <div className="onboard-looks" ref={menu} onKeyDown={onKeyDown} role="group" aria-label="Look">
        <Cycle {...row(0)} legend="Hoodie" group="hoodie" items={HOODIES} value={profile.hoodie} onChange={(hoodie) => update({ hoodie })} />
        <Cycle {...row(1)} legend="Laptop" group="shell" items={SHELLS} value={profile.shell} onChange={(shell) => update({ shell })} />
        <Stickers {...row(2)} value={profile.stickers} onChange={(stickers) => update({ stickers })} />
        <Cycle {...row(3)} legend="Screen" group="phosphor" items={PHOSPHORS} value={profile.phosphor} onChange={(phosphor) => update({ phosphor })} />
        <Cycle {...row(4)} legend="Room" group="room" items={ROOMS} value={profile.room} onChange={(room) => update({ room })} />
        <Cycle {...row(5)} legend="Voice" group="voice" items={voices} value={profile.voice} onChange={(voice) => update({ voice })} />
      </div>
      {/* The lit line's description, in one place with its height kept, so lighting a line never moves the menu. */}
      <p className="onboard-look-detail" aria-hidden="true">
        {look === 1 ? SHELLS.find((s) => s.id === profile.shell)?.note : look === 4 ? ROOMS.find((r) => r.id === profile.room)?.note : look === 5 ? voices.find((v) => v.id === profile.voice)?.note : null}
      </p>
    </>
  );
}

// ---- Menu lines ------------------------------------------------------------------

type RowProps = { "data-look": string; "data-on": true | undefined; onFocus: () => void; onPointerEnter: () => void; onPointerLeave: () => void };

/**
 * One menu line: the name, ◀ the value ▶, and a pip for each choice. The
 * pips are the radio buttons, so ←→ (and clicking a pip) choose natively.
 */
function Cycle({
  legend,
  group,
  items,
  value,
  onChange,
  ...row
}: RowProps & { legend: string; group: string; items: readonly (Choice & { color?: string })[]; value: string; onChange: (id: string) => void }) {
  const at = Math.max(0, items.findIndex((item) => item.id === value));
  const chosen = items[at]!;
  const step = (by: number) => onChange(items[(at + by + items.length) % items.length]!.id);
  return (
    <fieldset className="onboard-look" {...row}>
      <legend className="onboard-look-name">{legend}</legend>
      <div className="onboard-cycle">
        <button type="button" tabIndex={-1} aria-hidden="true" className="onboard-arrow" onClick={() => step(-1)} data-track="look-previous">
          <Arrow left />
        </button>
        <span className="onboard-look-value" aria-hidden="true">
          {chosen.color && <span className="onboard-chip" style={{ background: chosen.color }} />}
          {chosen.label}
        </span>
        <button type="button" tabIndex={-1} aria-hidden="true" className="onboard-arrow" onClick={() => step(1)} data-track="look-next">
          <Arrow />
        </button>
      </div>
      <div className="onboard-pips">
        {items.map((item) => (
          <label key={item.id} className="onboard-pip" data-on={item.id === value || undefined} title={item.label} style={item.color ? ({ "--swatch": item.color } as CSSProperties) : undefined}>
            <input type="radio" name={`look-${group}`} checked={item.id === value} onChange={() => onChange(item.id)} />
            <span className="sr-only">{item.note ? `${item.label}: ${item.note}` : item.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Stickers: up to four, so checkboxes in place of the arrows. ←→ move between them; space sticks one on. */
function Stickers({ value, onChange, ...row }: RowProps & { value: string[]; onChange: (ids: string[]) => void }) {
  const [art, setArt] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    const fonts = pageFonts();
    loadFonts(fonts)
      .then(() => Promise.all(STICKERS.map(async (s) => [s.id, await stickerDataUrl(s.id, fonts)] as const)))
      .then((pairs) => alive && setArt(Object.fromEntries(pairs)));
    return () => {
      alive = false;
    };
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const boxes = [...event.currentTarget.querySelectorAll<HTMLInputElement>("input")];
    const at = boxes.indexOf(event.target as HTMLInputElement);
    if (at < 0) return;
    event.preventDefault();
    boxes[Math.max(0, Math.min(boxes.length - 1, at + (event.key === "ArrowLeft" ? -1 : 1)))]?.focus();
  };
  return (
    <fieldset className="onboard-look" {...row}>
      <legend className="onboard-look-name">Stickers</legend>
      <span className="onboard-look-value">{value.length === 0 ? "None" : `${value.length} of ${MAX_STICKERS}`}</span>
      <div className="onboard-stickers" onKeyDown={onKeyDown}>
        {STICKERS.map((sticker) => {
          const on = value.includes(sticker.id);
          const full = !on && value.length >= MAX_STICKERS;
          return (
            <label key={sticker.id} className="onboard-sticker" data-on={on || undefined} data-off={full || undefined} title={sticker.label}>
              <input type="checkbox" checked={on} disabled={full} onChange={() => onChange(on ? value.filter((v) => v !== sticker.id) : [...value, sticker.id])} />
              {art[sticker.id] ? <img src={art[sticker.id]} alt="" width={40} height={40} /> : <span className="onboard-sticker-blank" />}
              <span className="sr-only">{sticker.label}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

// ---- Pixel icons -----------------------------------------------------------------

function Arrow({ left }: { left?: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 5 5" aria-hidden="true" shapeRendering="crispEdges" style={left ? { transform: "scaleX(-1)" } : undefined}>
      <path fill="currentColor" d="M1 0h1v1H1zM2 1h1v1H2zM3 2h1v1H3zM2 3h1v1H2zM1 4h1v1H1z" />
    </svg>
  );
}
