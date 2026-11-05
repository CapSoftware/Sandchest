/**
 * The sand over the landing page's crawl, in the chest's Bayer dither and
 * palette: ribbons of sand winding slowly across the sky above the text, and
 * loose grains that fly off the letters as they crumble.
 *
 * Also where the letters crumble: `crumbleMask` says which cells of the band
 * still show text. Its edge is ragged noise, fixed on the screen, so text
 * rising through it comes apart cell by cell.
 *
 * Pure pixel code with no DOM dependencies.
 */
import { bayer, clamp01, hash, LIGHT_RAMP } from "./chest-dither";

type Rgb = readonly [number, number, number];

const hex = (h: string): Rgb => [Number.parseInt(h.slice(1, 3), 16), Number.parseInt(h.slice(3, 5), 16), Number.parseInt(h.slice(5, 7), 16)];

const SAND_RAMP: readonly Rgb[] = [[0, 0, 0], hex("#4a3b2c"), hex("#a69479"), hex("#c2b293"), hex("#f3e5c8")];
/** Grain colours: sand for advisories, gold for Sandchest's findings. */
export const RAMP = { sand: 0, gold: 1 } as const;
const RAMPS = [SAND_RAMP, LIGHT_RAMP] as const;
const STEPS = 4;

/** Where, as shares of the band's height from the top, text has fully crumbled, and where it starts to. */
export const CRUMBLE = { gone: 0.36, from: 0.6 } as const;
/** Rows at the bottom over which text appears, as a share of the band. */
const ENTER = 0.05;

const MAX_GRAINS = 5000;
/** Ribbons of sand winding across the upper band, and how many grains make one. */
const RIBBONS = 3;
const RIBBON_GRAINS = 600;
/** Columns at each side over which the sand fades into the page, as a share of the width. */
const SIDES = 0.1;

const ease = (t: number) => t * t * (3 - 2 * t);

/** A fixed value per cell, part random and part ordered, that the crumbling line is compared with. */
const cellNoise = (x: number, y: number) => 0.65 * hash(x * 7919 + y * 104_729) + 0.35 * bayer(x, y);

/** How much of a row still shows text, from 1 (all of it) to 0 (none). */
function keepShare(y: number, rows: number): number {
  const p = (y + 0.5) / rows;
  const enter = clamp01((1 - p) / ENTER);
  return ease(clamp01((p - CRUMBLE.gone) / (CRUMBLE.from - CRUMBLE.gone))) * ease(enter);
}

/** Whether text shows at a cell. */
export function keeps(x: number, y: number, rows: number): boolean {
  return cellNoise(x, y) < keepShare(y, rows);
}

/** The mask for the whole band, one byte per cell: 255 where text shows. */
export function crumbleMask(cols: number, rows: number): Uint8Array {
  const mask = new Uint8Array(cols * rows);
  for (let y = 0; y < rows; y++) {
    const share = keepShare(y, rows);
    for (let x = 0; x < cols; x++) mask[y * cols + x] = cellNoise(x, y) < share ? 255 : 0;
  }
  return mask;
}

export interface Sand {
  /** Lets a grain fly off from a cell, at a brightness from 0 to 1. */
  spawn(x: number, y: number, bright: number, ramp: number): void;
  /** Moves everything on by `dt` seconds without drawing: for running time on unseen. */
  advance(time: number, dt: number): void;
  /** Moves everything on by `dt` seconds (0 for a still frame) and draws it into `out` (RGBA, cols × rows). */
  render(out: Uint8ClampedArray, time: number, dt: number): void;
}

export function createSand(cols: number, rows: number): Sand {
  let seed = 1;
  const rand = () => hash(seed++);

  const sideFade = new Float32Array(cols);
  for (let x = 0; x < cols; x++) sideFade[x] = ease(clamp01(Math.min(x + 0.5, cols - x - 0.5) / (cols * SIDES)));

  // Loose grains: struct of arrays.
  const gx = new Float32Array(MAX_GRAINS);
  const gy = new Float32Array(MAX_GRAINS);
  const gvx = new Float32Array(MAX_GRAINS);
  const gvy = new Float32Array(MAX_GRAINS);
  const gAge = new Float32Array(MAX_GRAINS);
  const gLife = new Float32Array(MAX_GRAINS);
  const gBright = new Float32Array(MAX_GRAINS);
  const gRamp = new Uint8Array(MAX_GRAINS);
  let grains = 0;

  /** The wind the loose grains ride: up and away, swaying side to side. Cells per second. */
  const windX = (x: number, y: number, time: number) =>
    (x - cols / 2) * 0.05 + 15 * Math.sin(y * 0.045 + time * 0.33) + 8 * Math.sin(x * 0.02 - time * 0.41);
  const windY = (x: number, time: number) => -12 + 5 * Math.cos(x * 0.03 + time * 0.37);

  // Ribbons: each grain has a place along its ribbon (0 to 1), a speed, and a place across it.
  const ribbonCount = RIBBONS * RIBBON_GRAINS;
  const rAlong = new Float32Array(ribbonCount);
  const rSpeed = new Float32Array(ribbonCount);
  const rAcross = new Float32Array(ribbonCount);
  const rBright = new Float32Array(ribbonCount);
  for (let i = 0; i < ribbonCount; i++) {
    rAlong[i] = rand();
    rSpeed[i] = 0.03 + rand() * 0.028;
    // Bunched towards the middle of the ribbon.
    rAcross[i] = (rand() + rand() + rand() - 1.5) / 1.5;
    rBright[i] = 0.35 + rand() * 0.5;
  }
  const ribbonY = (r: number, x: number, time: number) => {
    const p = x / cols;
    // Each ribbon its own height, curve and pace, so they never mirror each other.
    return (
      rows *
      (0.08 + 0.12 * r + (0.09 - 0.02 * r) * Math.sin(p * (3.3 + 1.9 * r) + time * (0.19 + 0.07 * r) + r * 2.1) +
        0.04 * Math.sin(p * (8.7 + 2.6 * r) - time * (0.33 - 0.05 * r) + r * 4.7))
    );
  };

  const dust = new Float32Array(cols * rows);
  const dustRamp = new Uint8Array(cols * rows);
  const plot = (x: number, y: number, v: number, ramp: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    if (xi < 0 || xi >= cols || yi < 0 || yi >= rows) return;
    const at = yi * cols + xi;
    if (v > dust[at]!) {
      dust[at] = v;
      dustRamp[at] = ramp;
    }
  };

  const moveGrains = (time: number, dt: number) => {
    const pull = Math.min(1, dt * 1.2);
    for (let i = 0; i < grains; ) {
      gAge[i]! += dt;
      const x = gx[i]!;
      gvx[i]! += (windX(x, gy[i]!, time) - gvx[i]!) * pull;
      gvy[i]! += (windY(x, time) - gvy[i]!) * pull;
      gx[i] = x + gvx[i]! * dt;
      gy[i] = gy[i]! + gvy[i]! * dt;
      if (gAge[i]! < gLife[i]! && gx[i]! >= -2 && gx[i]! <= cols + 2 && gy[i]! >= -2) {
        i++;
        continue;
      }
      // Gone: move the last grain into this slot.
      grains--;
      gx[i] = gx[grains]!;
      gy[i] = gy[grains]!;
      gvx[i] = gvx[grains]!;
      gvy[i] = gvy[grains]!;
      gAge[i] = gAge[grains]!;
      gLife[i] = gLife[grains]!;
      gBright[i] = gBright[grains]!;
      gRamp[i] = gRamp[grains]!;
    }
  };

  return {
    spawn(x, y, bright, ramp) {
      if (grains >= MAX_GRAINS) return;
      const i = grains++;
      gx[i] = x;
      gy[i] = y;
      gvx[i] = (rand() - 0.5) * 10;
      gvy[i] = -2 - rand() * 6;
      gAge[i] = 0;
      gLife[i] = 2.2 + rand() * 3;
      gBright[i] = bright;
      gRamp[i] = ramp;
    },

    advance(time, dt) {
      moveGrains(time, dt);
      for (let i = 0; i < rAlong.length; i++) rAlong[i] = (rAlong[i]! + rSpeed[i]! * dt) % 1;
    },

    render(out, time, dt) {
      if (dt > 0) this.advance(time, dt);
      dust.fill(0);
      for (let i = 0; i < grains; i++) plot(gx[i]!, gy[i]!, gBright[i]! * (1 - gAge[i]! / gLife[i]!) ** 1.2, gRamp[i]!);
      for (let r = 0; r < RIBBONS; r++) {
        // Alternate ribbons run opposite ways.
        const forward = r % 2 === 0;
        for (let k = 0; k < RIBBON_GRAINS; k++) {
          const i = r * RIBBON_GRAINS + k;
          const along = rAlong[i]!;
          const x = forward ? -0.1 * cols + along * 1.2 * cols : 1.1 * cols - along * 1.2 * cols;
          // Thick in the middle, thinning to a thread at each end, and breathing.
          const swell = Math.sin(Math.PI * along);
          const thickness = rows * (0.01 + 0.04 * swell ** 1.5) * (0.8 + 0.2 * Math.sin(time * 0.9 + along * 9 + r));
          plot(x, ribbonY(r, x, time) + rAcross[i]! * thickness, rBright[i]! * swell ** 1.4 * (1 - Math.abs(rAcross[i]!) * 0.5), RAMP.gold);
        }
      }

      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const at = y * cols + x;
          const o = at * 4;
          const v = dust[at]! * sideFade[x]!;
          const level = v > 0 ? Math.min(STEPS, Math.floor(clamp01(v) * STEPS + bayer(x, y))) : 0;
          if (level === 0) {
            out[o + 3] = 0;
            continue;
          }
          const c = RAMPS[dustRamp[at] as 0 | 1][level]!;
          out[o] = c[0];
          out[o + 1] = c[1];
          out[o + 2] = c[2];
          out[o + 3] = 255;
        }
      }
    },
  };
}
