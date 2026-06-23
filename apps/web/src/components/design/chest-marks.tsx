/* ----------------------------------------------------------------------------
   Sandchest — chest mark explorations.

   Twelve hand-drawn directions for the icon. All keep the core idea (a chest /
   lid / lock) but push it somewhere different. Two kinds:

   - Adaptive marks draw with `currentColor` so the page can recolor them per
     background (gold on dark, ink on light). Good favicon candidates.
   - Palette marks carry their own fills (gold gradients, isometric shading,
     tiles) and are meant to sit on a dark or neutral cell.

   Every gradient / clip id is suffixed per-component so multiple marks can live
   on one page without colliding.
---------------------------------------------------------------------------- */

import type { FC } from "react";

type MarkProps = { className?: string };

// brand palette (warm sand + gold), shared by the fixed-fill marks
const GOLD = "#FEC242";
const LIGHT = "#FDD363";
const AMBER = "#F5A524";
const ACCENT = "#F5853F";
const DEEP = "#C25A2C";
const BROWN = "#7A3F22";
const DARK = "#241A0E";
const SAND_BLACK = "#15120C";

/* 01 — Monoline. One stroke weight, rounded joins. The reductive, modern take
   that still reads as a chest at 16px. */
export function MonolineChest({ className }: MarkProps) {
  return (
    <svg viewBox="0 0 48 48" className={className} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 25c0-7.2 6-11.6 15-11.6S39 17.8 39 25" />
      <path d="M9 25v9.5A2.5 2.5 0 0 0 11.5 37h25A2.5 2.5 0 0 0 39 34.5V25" />
      <path d="M7.4 25h33.2" />
      <circle cx="24" cy="29" r="1.9" fill="currentColor" stroke="none" />
      <path d="M24 29v3.3" />
    </svg>
  );
}

/* 02 — Solid. Flat two-tone fill, lid in accent, body in gold. The plainest,
   most app-store-safe evolution of what you have now. */
export function SolidChest({ className }: MarkProps) {
  return (
    <svg viewBox="0 0 48 48" className={className} fill="none" aria-hidden>
      <rect x="9" y="24" width="30" height="14" rx="2.5" fill={GOLD} />
      <path d="M9 25c0-7.5 6-12 15-12s15 4.5 15 12Z" fill={ACCENT} />
      <rect x="7.5" y="23" width="33" height="3.4" rx="1.2" fill={DEEP} />
      <rect x="20.3" y="22.4" width="7.4" height="9" rx="1.6" fill={DEEP} />
      <circle cx="24" cy="26.6" r="1.5" fill={SAND_BLACK} />
      <path d="M24 26.6 22.9 30.4h2.2z" fill={SAND_BLACK} />
    </svg>
  );
}

/* 03 — Strapped. Iron straps + corner feet. Closest to the current detailed
   chest, but flattened and cleaned up. */
export function StrappedChest({ className }: MarkProps) {
  return (
    <svg viewBox="0 0 48 48" className={className} fill="none" aria-hidden>
      <rect x="9" y="24" width="30" height="14" rx="2.5" fill={GOLD} />
      <path d="M9 25c0-7.5 6-12 15-12s15 4.5 15 12Z" fill={ACCENT} />
      <rect x="13.5" y="14.5" width="3" height="23.5" fill={DEEP} opacity="0.85" />
      <rect x="31.5" y="14.5" width="3" height="23.5" fill={DEEP} opacity="0.85" />
      <rect x="7.5" y="23" width="33" height="3.4" rx="1.2" fill={DEEP} />
      <rect x="20.6" y="22.6" width="6.8" height="8.4" rx="1.4" fill={BROWN} />
      <circle cx="24" cy="26.4" r="1.4" fill={LIGHT} />
      <path d="M24 26.4 23 29.8h2z" fill={LIGHT} />
      <rect x="9.5" y="37" width="4.5" height="3" rx="1" fill={DEEP} />
      <rect x="34" y="37" width="4.5" height="3" rx="1" fill={DEEP} />
    </svg>
  );
}

/* 04 — Pixel. 8-bit treasure chest. Leans into the sandbox / dev-tool / loot
   feeling. Authored from a tiny char map so the grid stays honest. */
const PIXEL_MAP = [
  "..oooooooooo..",
  ".oyyyyyyyyyyo.",
  ".ollllllllllo.",
  "oyllllllllllyo",
  "oyyyyyyyyyyyyo",
  "oooooooooooooo",
  "oyyyyyllyyyyyo",
  "oyyyyylkyyyyyo",
  "oyyyyyllyyyyyo",
  "oyyyyyyyyyyyyo",
  "oooooooooooooo",
  ".oo........oo.",
];
const PIXEL_FILL: Record<string, string> = { o: BROWN, y: GOLD, l: LIGHT, k: DARK };

export function PixelChest({ className }: MarkProps) {
  const cell = 3;
  const ox = (48 - PIXEL_MAP[0].length * cell) / 2;
  const oy = (48 - PIXEL_MAP.length * cell) / 2;
  return (
    <svg viewBox="0 0 48 48" className={className} fill="none" shapeRendering="crispEdges" aria-hidden>
      {PIXEL_MAP.flatMap((row, r) =>
        row.split("").map((ch, c) =>
          ch === "." ? null : (
            <rect
              key={`${r}-${c}`}
              x={ox + c * cell}
              y={oy + r * cell}
              width={cell + 0.4}
              height={cell + 0.4}
              fill={PIXEL_FILL[ch]}
            />
          ),
        ),
      )}
    </svg>
  );
}

/* 05 — Open. Lid lifted, light + sparkles spilling out. The "open the chest of
   models" story — more illustrative, good for hero / OG art. */
export function OpenChest({ className }: MarkProps) {
  return (
    <svg viewBox="0 0 48 48" className={className} fill="none" aria-hidden>
      <defs>
        <linearGradient id="open-glow" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor={AMBER} stopOpacity="0" />
          <stop offset="1" stopColor={LIGHT} stopOpacity="0.9" />
        </linearGradient>
      </defs>
      <polygon points="18,25 30,25 33,7 15,7" fill="url(#open-glow)" />
      <path d="M13 16 39 16 37 23 11 23Z" fill={ACCENT} />
      <path d="M13.5 13.4 38.5 13.4 39 16 13 16Z" fill={DEEP} />
      <rect x="10" y="24" width="28" height="14" rx="2.5" fill={GOLD} />
      <rect x="8.5" y="22.6" width="31" height="3.4" rx="1.2" fill={DEEP} />
      <g fill={AMBER}>
        <path d="M24 4.5l1.1 2.2 2.2 1.1-2.2 1.1L24 11.1l-1.1-2.1-2.2-1.1 2.2-1.1z" />
        <path d="M16.5 11l.7 1.5 1.5.7-1.5.7-.7 1.5-.7-1.5-1.5-.7 1.5-.7z" />
        <path d="M31 10l.7 1.5 1.5.7-1.5.7-.7 1.5-.7-1.5-1.5-.7 1.5-.7z" />
      </g>
    </svg>
  );
}

/* 06 — Tile. Chest silhouette punched out of a gold app-icon tile. Directly
   usable as the favicon / touch icon they already ship. */
export function TileChest({ className }: MarkProps) {
  return (
    <svg viewBox="0 0 48 48" className={className} fill="none" aria-hidden>
      <defs>
        <linearGradient id="tile-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={LIGHT} />
          <stop offset="0.55" stopColor={GOLD} />
          <stop offset="1" stopColor={ACCENT} />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="44" height="44" rx="12" fill="url(#tile-bg)" />
      <rect x="2" y="2" width="44" height="19" rx="12" fill="#ffffff" opacity="0.12" />
      <g fill={SAND_BLACK}>
        <path d="M14 24c0-6 4.6-9.6 10-9.6S34 18 34 24Z" />
        <rect x="14" y="23.4" width="20" height="11" rx="2" />
        <rect x="12.4" y="22.4" width="23.2" height="2.7" rx="1.1" />
      </g>
      <circle cx="24" cy="27" r="1.5" fill="url(#tile-bg)" />
    </svg>
  );
}

/* 07 — Brackets. The lock becomes code: chevrons inside the chest. Says
   "coding tool" without a word of copy. Adaptive. */
export function BracketsChest({ className }: MarkProps) {
  return (
    <svg viewBox="0 0 48 48" className={className} fill="none" stroke="currentColor" strokeWidth={2.3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 25c0-6.8 5.6-11 14-11s14 4.2 14 11" />
      <path d="M10 25v9.4A2.4 2.4 0 0 0 12.4 36.8h23.2A2.4 2.4 0 0 0 38 34.4V25" />
      <path d="M8.6 25h30.8" />
      <path d="M21 28.4 17.6 31.4 21 34.4" />
      <path d="M27 28.4 30.4 31.4 27 34.4" />
    </svg>
  );
}

/* 08 — Terminal. Chest as a terminal window: lid bar + clasp up top, a prompt
   below in accent. Merges sandbox + chest. Adaptive shell, accent prompt. */
export function TerminalChest({ className }: MarkProps) {
  return (
    <svg viewBox="0 0 48 48" className={className} fill="none" aria-hidden>
      <rect x="8" y="15" width="32" height="23" rx="3.5" stroke="currentColor" strokeWidth={2.2} />
      <path d="M8 22.6h32" stroke="currentColor" strokeWidth={2.2} />
      <rect x="20.8" y="18.6" width="6.4" height="8" rx="1.6" stroke="currentColor" strokeWidth={1.8} />
      <circle cx="24" cy="22.6" r="1" fill="currentColor" />
      <path d="M14 28.5 17.2 31.2 14 33.9" stroke={ACCENT} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M20.5 34h7" stroke={ACCENT} strokeWidth={2.2} strokeLinecap="round" />
    </svg>
  );
}

/* 09 — Iso. Low isometric box, three tones of gold. Reads as a premium,
   tangible object — nice for 3D / spatial treatments. */
export function IsoChest({ className }: MarkProps) {
  return (
    <svg viewBox="0 0 48 48" className={className} fill="none" aria-hidden>
      <polygon points="24,13 38,20 24,27 10,20" fill={LIGHT} />
      <polygon points="10,20 24,27 24,40 10,33" fill={GOLD} />
      <polygon points="24,27 38,20 38,33 24,40" fill={ACCENT} />
      <polygon points="10,26 24,33 24,36 10,29" fill={DEEP} />
      <polygon points="24,33 38,26 38,29 24,36" fill={DEEP} opacity="0.82" />
      <polygon points="17,32.6 19.6,33.9 17,35.2 14.4,33.9" fill={DARK} />
    </svg>
  );
}

/* 10 — Clasp. The most abstract: lid arc + band + keyhole, nothing else. The
   "make it a logo, not an illustration" option. Adaptive. */
export function ClaspChest({ className }: MarkProps) {
  return (
    <svg viewBox="0 0 48 48" className={className} fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 27c0-8.6 6.5-13.2 15-13.2S39 18.4 39 27" />
      <path d="M7.8 27h32.4" />
      <circle cx="24" cy="21.4" r="2.2" fill="currentColor" stroke="none" />
      <path d="M24 21.4v3.6" />
    </svg>
  );
}

/* 11 — Monogram. An "S" on a gold tile, with the chest lock as the seam in the
   letter. Initial-led, works where a full chest is too busy. */
export function MonogramChest({ className }: MarkProps) {
  return (
    <svg viewBox="0 0 48 48" className={className} fill="none" aria-hidden>
      <defs>
        <linearGradient id="mono-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={LIGHT} />
          <stop offset="0.55" stopColor={GOLD} />
          <stop offset="1" stopColor={ACCENT} />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="44" height="44" rx="12" fill="url(#mono-bg)" />
      <rect x="2" y="2" width="44" height="19" rx="12" fill="#ffffff" opacity="0.12" />
      <path
        d="M31 19.5C31 15.5 18 15.2 18 20.4 18 25.4 31 23 31 28 31 33 18 32.6 18 28.4"
        fill="none"
        stroke={SAND_BLACK}
        strokeWidth={4.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="24" cy="24" r="1.5" fill="url(#mono-bg)" />
    </svg>
  );
}

/* 12 — Sand. Body filled with graded strata, like sediment in the chest. Pulls
   on the "sand" half of the name the others ignore. */
export function SandChest({ className }: MarkProps) {
  return (
    <svg viewBox="0 0 48 48" className={className} fill="none" aria-hidden>
      <defs>
        <clipPath id="sand-body">
          <rect x="10" y="24" width="28" height="14" rx="2.5" />
        </clipPath>
      </defs>
      <path d="M10 25c0-7.5 6-12 14-12s14 4.5 14 12Z" fill={DEEP} />
      <g clipPath="url(#sand-body)">
        <rect x="10" y="24" width="28" height="5" fill={LIGHT} />
        <rect x="10" y="29" width="28" height="5" fill={GOLD} />
        <rect x="10" y="34" width="28" height="5" fill={AMBER} />
      </g>
      <rect x="8.5" y="23" width="31" height="3" rx="1.2" fill={DEEP} />
      <circle cx="24" cy="31" r="1.7" fill={DARK} />
      <path d="M24 31 22.8 35h2.4z" fill={DARK} />
    </svg>
  );
}

export type ChestMark = {
  no: string;
  id: string;
  name: string;
  note: string;
  Comp: FC<MarkProps>;
  /** draws with currentColor — recolor per background, favicon-friendly */
  adaptive: boolean;
};

export const MARKS: ChestMark[] = [
  { no: "01", id: "monoline", name: "Monoline", note: "One weight, rounded. Holds up at 16px.", Comp: MonolineChest, adaptive: true },
  { no: "02", id: "solid", name: "Solid", note: "Flat two-tone. The safe evolution.", Comp: SolidChest, adaptive: false },
  { no: "03", id: "strapped", name: "Strapped", note: "Straps + feet. Nearest to today's chest.", Comp: StrappedChest, adaptive: false },
  { no: "04", id: "pixel", name: "Pixel", note: "8-bit loot. Sandbox / dev energy.", Comp: PixelChest, adaptive: false },
  { no: "05", id: "open", name: "Open", note: "Lid up, light out. Hero & OG art.", Comp: OpenChest, adaptive: false },
  { no: "06", id: "tile", name: "Tile", note: "Silhouette in a gold app icon.", Comp: TileChest, adaptive: false },
  { no: "07", id: "brackets", name: "Brackets", note: "The lock is code. Reads as a coding tool.", Comp: BracketsChest, adaptive: true },
  { no: "08", id: "terminal", name: "Terminal", note: "Chest as a shell window + prompt.", Comp: TerminalChest, adaptive: true },
  { no: "09", id: "iso", name: "Isometric", note: "Three tones, tangible object.", Comp: IsoChest, adaptive: false },
  { no: "10", id: "clasp", name: "Clasp", note: "Lid + keyhole only. A logo, not a drawing.", Comp: ClaspChest, adaptive: true },
  { no: "11", id: "monogram", name: "Monogram", note: "An S with a lock seam. Initial-led.", Comp: MonogramChest, adaptive: false },
  { no: "12", id: "sand", name: "Sand", note: "Strata in the chest. Owns the 'sand'.", Comp: SandChest, adaptive: false },
];
