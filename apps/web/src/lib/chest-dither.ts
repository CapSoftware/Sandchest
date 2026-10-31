/**
 * Bayer-dithered hero scene: the logo chest being hacked open.
 *
 * Pure pixel code with no DOM dependencies, so the same frames are drawn by
 * the hero canvas in the browser and by `scripts/render-chest-fallback.ts`,
 * which writes the static image shown without JavaScript.
 *
 * Sequence, in seconds after it starts (see TIMELINE):
 *   breach  hex glyphs spiral into the keyhole, a scanline sweeps the chest,
 *           the lock clicks three times and glitches
 *   rattle  the lid shakes
 *   open    the lid bursts open: shockwave, sparks
 *   steady  fire burns in the open chest: flames lick up past the lid and
 *           embers rise, all within the chest's glow
 *
 * Everything stays inside the scene panel; nothing moves elsewhere on the page.
 */

/** The logo icon (561 × 473 viewBox) is rasterised at this width. */
export const ICON_VIEWBOX_W = 561;
export const ICON_VIEWBOX_H = 473;
export const SPRITE_W = 160;
export const SPRITE_H = Math.round((ICON_VIEWBOX_H * SPRITE_W) / ICON_VIEWBOX_W);

/** Height of the scene panel in grid cells. Must match --scene-rows in CSS. */
export const SCENE_ROWS = 136;
/** Empty rows below the chest. */
const FLOOR_ROWS = 22;

/** Size of the static fallback frame, as wide as the widest panel. */
export const FALLBACK_W = 256;
export const FALLBACK_H = SCENE_ROWS;

export const TIMELINE = { breach: 1.9, rattle: 0.35, open: 1.4 } as const;
const OPEN_AT = TIMELINE.breach + TIMELINE.rattle;
/** After this the scene loops calmly and can run at a lower frame rate. */
export const STEADY_AT = OPEN_AT + TIMELINE.open + 1.4;
const CLICKS = [0.75, 1.25, 1.65];
const CLICK_LIFE = 0.55;
const BURST_LIFE = 1.7;

const S = SPRITE_W / ICON_VIEWBOX_W;

/** Chest geometry in icon viewBox units. */
const CHEST = {
  left: 100,
  right: 461,
  top: 100,
  bottom: 372,
  /** Where the lid meets the body. */
  seam: 243.5,
  keyX: 280,
  keyY: 222,
};

const LID_TOP = CHEST.top * S;
const SEAM = CHEST.seam * S;
const BODY_BOTTOM = CHEST.bottom * S;
const INNER_L = (CHEST.left + 6) * S;
const INNER_R = (CHEST.right - 6) * S;
const LID_LIFT = 34;
const LID_TILT = 10;

type Rgb = readonly [number, number, number];

const hex = (h: string): Rgb => [
  Number.parseInt(h.slice(1, 3), 16),
  Number.parseInt(h.slice(3, 5), 16),
  Number.parseInt(h.slice(5, 7), 16),
];

/** Logo palette. VOID is "no ink" and is written as transparent. */
const VOID: Rgb = [0, 0, 0];
const RUST = hex("#C25A2C");
const EMBER = hex("#D76839");
const AMBER = hex("#FF9F19");
const HONEY = hex("#FEA121");
const GOLD = hex("#FEC242");

const CHEST_PALETTE: readonly Rgb[] = [VOID, RUST, EMBER, AMBER, HONEY, GOLD];
/** Light ramp, darkest to brightest, for glow, rays, glyphs and sparks. */
const LIGHT_RAMP: readonly Rgb[] = [VOID, RUST, EMBER, AMBER, GOLD];
const LIGHT_STEPS = LIGHT_RAMP.length - 1;

/** Per-channel jitter applied before nearest-colour matching on the chest. */
const CHEST_SPREAD = 44;

const BAYER_8 = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60,
  28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47,
  7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
].map((v) => (v + 0.5) / 64);

const bayer = (x: number, y: number) => BAYER_8[((y & 7) << 3) | (x & 7)];

/** 3 × 5 hex digits, row by row. */
const GLYPHS = [
  "111101101101111",
  "010110010010111",
  "111001111100111",
  "111001111001111",
  "101101111001001",
  "111100111001111",
  "111100111101111",
  "111001001001001",
  "111101111101111",
  "111101111001111",
  "010101111101101",
  "110101110101110",
  "011100100100011",
  "110101101101110",
  "111100110100111",
  "111100110100100",
].map((g) => Array.from(g, (c) => c === "1"));

/** Deterministic hash to [0, 1), so frames are reproducible. */
const hash = (n: number) => {
  let h = Math.imul(n | 0, 0x27d4eb2d) ^ 0x165667b1;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const easeOutBack = (t: number) => {
  const c = 1.25;
  return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
};

const VORTEX = Array.from({ length: 180 }, (_, i) => ({
  angle: hash(i * 5 + 1) * Math.PI * 2,
  reach: 0.35 + hash(i * 5 + 2) * 0.65,
  speed: 0.5 + hash(i * 5 + 3) * 0.7,
  phase: hash(i * 5 + 4),
  glyph: Math.floor(hash(i * 5 + 5) * 16),
}));

const EMBERS = Array.from({ length: 18 }, (_, i) => ({
  x: hash(i * 4 + 201) - 0.5,
  speed: 0.25 + hash(i * 4 + 202) * 0.35,
  phase: hash(i * 4 + 203),
  sway: hash(i * 4 + 204) * 6,
}));

/** Smooth 2D value noise in [0, 1). */
const lattice = (x: number, y: number) => hash(Math.imul(x, 374761393) + Math.imul(y, 668265263));
const noise = (x: number, y: number) => {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = lattice(xi, yi);
  const b = lattice(xi + 1, yi);
  const c = lattice(xi, yi + 1);
  const d = lattice(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
};
/** Three octaves of noise, for flames. */
const fbm = (x: number, y: number) =>
  (4 * noise(x, y) + 2 * noise(x * 2.03 + 17, y * 2.03 + 9) + noise(x * 4.1 + 5, y * 4.1 + 31)) / 7;

const SPARKS = Array.from({ length: 90 }, (_, i) => ({
  angle: -Math.PI / 2 + (hash(i * 3 + 101) - 0.5) * 2.9,
  speed: 50 + hash(i * 3 + 102) * 150,
  life: 0.7 + hash(i * 3 + 103) * 1,
}));

export interface Sprite {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

/** A scene of `width × height` grid cells with the chest at the bottom centre. */
export function createChestScene(sprite: Sprite, width: number, height: number) {
  const { width: sw, height: sh, data: px } = sprite;

  // Chest centred horizontally, resting just above the bottom edge.
  const ox = Math.round(width / 2 - ((CHEST.left + CHEST.right) / 2) * S);
  const oy = Math.round(height - FLOOR_ROWS - BODY_BOTTOM);
  const cx = width / 2;
  const cy = oy + ((CHEST.top + CHEST.bottom) / 2) * S;
  const kx = ox + CHEST.keyX * S;
  const ky = oy + CHEST.keyY * S;
  const vortexReach = Math.max(70, Math.min(width * 0.42, 140));

  // Fire burns on the gold inside the chest and rises to the top of the scene.
  const fireBase = oy + SEAM - 4;
  const fireHalf = ((INNER_R - INNER_L) / 2) * 0.85;
  const fireHeight = fireBase;

  const ink = (out: Uint8ClampedArray, i: number, c: Rgb) => {
    if (c === VOID) {
      out[i + 3] = 0;
      return;
    }
    out[i] = c[0];
    out[i + 1] = c[1];
    out[i + 2] = c[2];
    out[i + 3] = 255;
  };

  const lightColour = (level: number, threshold: number) => {
    const step = Math.floor(clamp01(level) * LIGHT_STEPS + threshold);
    return LIGHT_RAMP[step > LIGHT_STEPS ? LIGHT_STEPS : step];
  };

  /** Ink a single overlay cell (glyph, spark). */
  const dot = (out: Uint8ClampedArray, x: number, y: number, level: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const c = lightColour(level, bayer(x, y));
    if (c !== VOID) ink(out, (y * width + x) * 4, c);
  };

  const glyph = (out: Uint8ClampedArray, g: number, x: number, y: number, level: number) => {
    const bits = GLYPHS[g & 15];
    const gx = Math.round(x) - 1;
    const gy = Math.round(y) - 2;
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 3; c++) {
        if (bits[r * 3 + c]) dot(out, gx + c, gy + r, level);
      }
    }
  };

  /**
   * @param clock seconds since the page started, seeds the glitches
   * @param since seconds since the hack started, or a negative number before
   */
  const render = (out: Uint8ClampedArray, clock: number, since: number) => {
    // Timeline.
    const breach = since < 0 ? 0 : clamp01(since / TIMELINE.breach);
    const vortex =
      since < 0 ? 0 : smooth(0, 0.35, since) * (1 - smooth(TIMELINE.breach - 0.1, OPEN_AT, since));
    const openT = clamp01((since - OPEN_AT) / TIMELINE.open);
    const open = since < OPEN_AT ? 0 : easeOutBack(openT);
    const shown = clamp01(open);
    const burst = since >= OPEN_AT ? since - OPEN_AT : -1;

    let rattle = 0;
    let glitch = 0;
    if (since >= TIMELINE.breach && since < OPEN_AT) {
      const r = since - TIMELINE.breach;
      rattle = Math.sin(r * 55) * 1.8;
      glitch = 0.9;
    }
    for (const c of CLICKS) {
      const dt = since - c;
      if (dt >= 0 && dt < 0.14) glitch = Math.max(glitch, 1 - dt / 0.14);
    }
    const glitchSeed = Math.floor(clock * 24);

    const scanning = since >= 0 && since < TIMELINE.breach;
    const scanY = LID_TOP + ((since / 0.95) % 1) * (BODY_BOTTOM - LID_TOP + 10) - 5;

    const keyGlow =
      since < 0 ? 0 : since < OPEN_AT ? 0.25 + 0.75 * breach ** 1.5 : 0.6;

    const lidTop = LID_TOP - LID_TILT * open;
    const lidBottom = SEAM - LID_LIFT * open;
    const lidScale = (SEAM - LID_TOP) / (lidBottom - lidTop);
    const lidDx = Math.round(rattle);
    const mouthY = oy + (lidBottom + SEAM) / 2;

    const ignite = since < OPEN_AT ? 0 : smooth(0.15, 0.9, openT);
    const pulse = 1 + 0.1 * Math.sin(clock * 2.3) + 0.05 * Math.sin(clock * 6.7);
    // The glow around the chest flickers with the fire.
    const haloStrength = 0.32 * (1 + 0.7 * vortex + 0.55 * shown) * (1 + (pulse - 1) * ignite);
    const flameT = clock * 1.9;

    /** Flames rising out of the chest, at grid cell (x, y). */
    const fireLight = (x: number, y: number, sway: number) => {
      const rise = fireBase - y;
      if (rise < -6) return 0;
      const up = clamp01(rise / fireHeight);
      const dx = x - cx;
      // Warm light where the fire meets the gold.
      const bx = dx / fireHalf;
      const by = rise / 12;
      let level = 0.3 * pulse * Math.exp(-(bx * bx + by * by));
      // Tongues of flame: noise scrolling upward, swaying more as they rise.
      const half = fireHalf * (1 - 0.6 * up);
      const across = Math.abs(dx + sway * up) / half;
      if (across < 1) {
        const n = fbm(dx * 0.1, (y + clock * 26) * 0.08);
        const body = (1 - across * across) * (1 - up) ** 0.5;
        level += clamp01(body * 1.3 + (n - 0.5) * 1.7 - 0.36);
      }
      return ignite * level;
    };

    /** Writes the chest pixel at sprite (sx, sy), if any. */
    const chestInk = (i: number, sx: number, sy: number, th: number, boost: number) => {
      if (sx < 0 || sy < 0 || sx >= sw || sy >= sh) return false;
      const p = (sy * sw + sx) * 4;
      if (px[p + 3] / 255 <= th) return false;

      // The keyhole is the only near-black part of the icon: light it up.
      if (px[p] + px[p + 1] + px[p + 2] < 90) {
        const flicker = since < OPEN_AT ? 0.8 + 0.2 * Math.sin(clock * 37 + sy) : 1;
        ink(out, i, lightColour(keyGlow * flicker, th));
        return true;
      }

      const jitter = (th - 0.5) * CHEST_SPREAD;
      const r = px[p] * boost + jitter;
      const g = px[p + 1] * boost + jitter;
      const b = px[p + 2] * boost + jitter;
      let best = CHEST_PALETTE[0];
      let bestD = Number.POSITIVE_INFINITY;
      for (const c of CHEST_PALETTE) {
        const dr = r - c[0];
        const dg = g - c[1];
        const db = b - c[2];
        // Weighted distance keeps the reds and golds from collapsing together.
        const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      ink(out, i, best);
      return true;
    };

    for (let y = 0; y < height; y++) {
      const sy = y - oy;

      // Glitch: some rows of the chest slip sideways and flash brighter.
      let shift = 0;
      let rowBoost = 1 + 0.12 * shown;
      // The fire lights the top of the chest's body.
      if (ignite > 0 && sy >= SEAM && sy < SEAM + 22) rowBoost += 0.12 * ignite * pulse * (1 - (sy - SEAM) / 22);
      const sway = ignite > 0 ? (fbm(y * 0.06, flameT) - 0.5) * 12 : 0;
      if (glitch > 0 && hash(sy * 131 + glitchSeed * 7919) > 0.7) {
        shift = Math.round((hash(sy * 17 + glitchSeed * 31) - 0.5) * 22 * glitch);
        rowBoost += 0.35 * glitch;
      }
      if (scanning) {
        const ds = sy - scanY;
        if (ds > -2 && ds < 1.5) rowBoost += 0.55;
        else if (ds <= -2 && ds > -12) rowBoost += 0.22 * (1 + ds / 12);
      }

      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const th = bayer(x, y);
        const sx = x - ox - shift;

        if (sy >= SEAM) {
          if (chestInk(i, sx, sy, th, rowBoost)) continue;
        } else if (sy >= lidTop && sy < lidBottom) {
          const srcY = Math.floor(LID_TOP + (sy - lidTop) * lidScale);
          if (chestInk(i, sx - lidDx, srcY, th, rowBoost)) continue;
        } else if (sy >= lidBottom && sx >= INNER_L && sx <= INNER_R) {
          // Inside the open chest: a heap of gold, burning.
          const gap = SEAM - lidBottom;
          const fromRim = (SEAM - sy) / 14;
          const heap = 0.5 + 0.14 * Math.sin(sx * 0.16 + 0.6) + 0.06 * Math.sin(sx * 0.47 + 2);
          const wall =
            fromRim < heap
              ? 0.7 + 0.3 * (1 - fromRim / heap)
              : 0.06 + 0.5 * clamp01(1 - (fromRim - heap) * 1.6) * clamp01(gap / 6);
          const level = ignite > 0 ? Math.max(wall, fireLight(x, y, sway)) : wall;
          ink(out, i, lightColour(level, th));
          continue;
        }

        // Halo around the chest.
        const hx = (x - cx) / 88;
        const hy = (y - cy) / 70;
        const hd = Math.sqrt(hx * hx + hy * hy);
        let level = hd < 1 ? haloStrength * (1 - hd) ** 2.6 : 0;
        if (ignite > 0) level += fireLight(x, y, sway);

        // Rings: each lock click, then the shockwave when the lid blows.
        const kdx = x - kx;
        const kdy = (y - ky) * 1.25;
        const kd = Math.sqrt(kdx * kdx + kdy * kdy);
        for (const c of CLICKS) {
          const dt = since - c;
          if (dt >= 0 && dt < CLICK_LIFE) {
            const ring = (kd - (8 + dt * 120)) / 2.2;
            level += 0.95 * (1 - dt / CLICK_LIFE) * Math.exp(-ring * ring);
          }
        }
        if (burst >= 0 && burst < BURST_LIFE) {
          const ring = (kd - burst * 260) / (2.5 + burst * 7);
          level += 1.15 * (1 - burst / BURST_LIFE) ** 1.5 * Math.exp(-ring * ring);
        }

        ink(out, i, lightColour(level, th));
      }
    }

    // Hex glyphs spiralling into the lock.
    if (vortex > 0) {
      for (let j = 0; j < VORTEX.length; j++) {
        const v = VORTEX[j];
        const p = (since * v.speed + v.phase) % 1;
        const r = vortexReach * v.reach * (1 - p) ** 1.35;
        if (r < 5) continue;
        const a = v.angle + (1 - p) ** 2 * 2.8 + since * 0.4;
        const level = vortex * smooth(0, 0.15, p) * (0.6 + 0.6 * p);
        const gx = kx + Math.cos(a) * r * 1.3;
        const gy = ky + Math.sin(a) * r * 0.8;
        // A short tail behind each glyph.
        for (let k = 1; k <= 3; k++) {
          const pt = p - k * 0.025;
          const rt = vortexReach * v.reach * (1 - pt) ** 1.35;
          const at = v.angle + (1 - pt) ** 2 * 2.8 + since * 0.4;
          dot(out, Math.round(kx + Math.cos(at) * rt * 1.3), Math.round(ky + Math.sin(at) * rt * 0.8), level * (0.6 - k * 0.15));
        }
        glyph(out, v.glyph + Math.floor(since * v.speed * 6), gx, gy, level);
      }
    }

    // Sparks thrown out when the lid blows.
    if (burst >= 0 && burst < 1.8) {
      for (const s of SPARKS) {
        if (burst > s.life) continue;
        const life = burst / s.life;
        const x = cx + Math.cos(s.angle) * s.speed * burst;
        const y = mouthY + Math.sin(s.angle) * s.speed * burst + 70 * burst * burst;
        const level = 1 - life * 0.8;
        dot(out, Math.round(x), Math.round(y), level);
        if (s.speed > 120) dot(out, Math.round(x - Math.cos(s.angle) * 2), Math.round(y - Math.sin(s.angle) * 2), level * 0.6);
      }
    }

    // Embers drifting up out of the fire.
    if (ignite > 0) {
      for (const e of EMBERS) {
        const life = (clock * e.speed + e.phase) % 1;
        const x = cx + e.x * fireHalf * (1.2 + life) + Math.sin(clock * 1.3 + e.phase * 9) * e.sway;
        const y = fireBase - 8 - life * (fireHeight + 4);
        dot(out, Math.round(x), Math.round(y), ignite * (1 - life) * 1.1);
      }
    }
  };

  return { render };
}
