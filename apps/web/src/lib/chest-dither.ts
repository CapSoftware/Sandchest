/**
 * Bayer-dithered hero scene: the logo chest being hacked, and sand running
 * out of its lock like an hourglass.
 *
 * Pure pixel code with no DOM dependencies, so the same frames are drawn by
 * the hero canvas in the browser and by `scripts/render-chest-fallback.ts`,
 * which writes the static image shown without JavaScript.
 *
 * Sequence, in seconds after it starts (see TIMELINE):
 *   breach  hex glyphs spiral into the keyhole, a scanline sweeps the chest,
 *           the lock clicks three times and glitches
 *   rattle  the lid shakes, and the lock gives: a shockwave from the keyhole
 *   pour    a thin stream of sand runs out of the keyhole and fills the floor
 *           of the panel, heaping up under the stream
 *   steady  the pile is full and stops rising; the stream keeps running into
 *           it for as long as the scene is on screen (see STEADY_AT)
 *
 * Cheap by design. The pile isn't simulated: its shape follows from how much
 * sand has fallen (a slope of sand at rest, filled to the right volume), so
 * any moment can be drawn directly. Once the lock's light show is over, the
 * chest and its glow never change, so that layer is drawn once and copied
 * under the sand each frame.
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

export const TIMELINE = { breach: 1.9, rattle: 0.35, pour: 9 } as const;
/** When the lock gives and the sand starts to run. */
const OPEN_AT = TIMELINE.breach + TIMELINE.rattle;
const CLICKS = [0.75, 1.25, 1.65];
const CLICK_LIFE = 0.55;
const BURST_LIFE = 1.7;
/** After this the chest and its glow are still, and only the sand moves: it can run at a lower frame rate. */
export const CALM_AT = OPEN_AT + BURST_LIFE;
/** Seconds for a grain to fall from the keyhole to the floor. */
const FALL_S = 0.95;
/** After this the pile is full and stops rising: only the stream moves, looping. */
export const STEADY_AT = OPEN_AT + FALL_S + TIMELINE.pour;
/** Cells per second squared, for the falling stream. */
const SAND_GRAVITY = 150;
/** The sand that runs out, as rows over the panel's whole width, and the slope it settles at. */
const FILL_ROWS = 19;
const REPOSE = 0.22;

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
/** Light ramp, darkest to brightest, for glow, rays, glyphs and sand. */
export const LIGHT_RAMP: readonly Rgb[] = [VOID, RUST, EMBER, AMBER, GOLD];
const LIGHT_STEPS = LIGHT_RAMP.length - 1;

/** Per-channel jitter applied before nearest-colour matching on the chest. */
const CHEST_SPREAD = 44;

const BAYER_8 = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60,
  28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47,
  7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
].map((v) => (v + 0.5) / 64);

export const bayer = (x: number, y: number) => BAYER_8[((y & 7) << 3) | (x & 7)];

/** 3 × 5 hex digits, row by row. */
export const GLYPHS = [
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
export const hash = (n: number) => {
  let h = Math.imul(n | 0, 0x27d4eb2d) ^ 0x165667b1;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const VORTEX = Array.from({ length: 180 }, (_, i) => ({
  angle: hash(i * 5 + 1) * Math.PI * 2,
  reach: 0.35 + hash(i * 5 + 2) * 0.65,
  speed: 0.5 + hash(i * 5 + 3) * 0.7,
  phase: hash(i * 5 + 4),
  glyph: Math.floor(hash(i * 5 + 5) * 16),
}));

/** Smooth 2D value noise in [0, 1). */
const lattice = (x: number, y: number) => hash(Math.imul(x, 374761393) + Math.imul(y, 668265263));
export const noise = (x: number, y: number) => {
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

  // The stream leaves the bottom of the keyhole; the pile heaps up under it.
  const streamX = Math.round(kx);
  const streamTop = Math.round(ky + 7);
  const fullVolume = width * FILL_ROWS;
  const pile = new Float32Array(width);
  /** The volume `pile` was last shaped for, so a full pile isn't reshaped every frame. */
  let pileVolume = -1;
  /** The chest and its glow once they've stopped changing, copied under the sand each frame. */
  let still: Uint8ClampedArray | null = null;

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

  /** Ink a single overlay cell (glyph, grain). */
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
   * Shapes the pile for `volume` cells of sand: a slope at rest, peaking
   * under the stream, as high as it must be to hold that much. The panel's
   * sides hold it in, so once it reaches them it rises flat.
   */
  const shapePile = (volume: number) => {
    if (volume === pileVolume) return;
    pileVolume = volume;
    if (volume <= 0) {
      pile.fill(0);
      return;
    }
    const held = (peak: number) => {
      let sum = 0;
      for (let x = 0; x < width; x++) {
        const h = peak - REPOSE * Math.abs(x - streamX);
        if (h > 0) sum += h;
      }
      return sum;
    };
    let lo = 0;
    let hi = height;
    for (let k = 0; k < 22; k++) {
      const mid = (lo + hi) / 2;
      if (held(mid) < volume) lo = mid;
      else hi = mid;
    }
    for (let x = 0; x < width; x++) {
      const h = lo - REPOSE * Math.abs(x - streamX);
      // A faint ripple on the surface, so it reads as sand and not a ramp.
      pile[x] = h > 0 ? h + Math.min(1, h / 4) * (0.6 * Math.sin(x * 0.31) + 0.35 * Math.sin(x * 0.83 + 1.7)) : 0;
    }
  };

  /** The chest, its glow, and the lock being picked: everything but the sand. */
  const renderChest = (out: Uint8ClampedArray, clock: number, since: number) => {
    const breach = since < 0 ? 0 : clamp01(since / TIMELINE.breach);
    const vortex =
      since < 0 ? 0 : smooth(0, 0.35, since) * (1 - smooth(TIMELINE.breach - 0.1, OPEN_AT, since));
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

    // The keyhole warms as the lock is worked, and stays lit once it gives: the sand's light.
    const keyGlow = since < 0 ? 0 : since < OPEN_AT ? 0.25 + 0.75 * breach ** 1.5 : 0.8;
    const lidDx = Math.round(rattle);
    const haloStrength = 0.32 * (1 + 0.7 * vortex);

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
      let rowBoost = 1;
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
        } else if (chestInk(i, sx - lidDx, sy, th, rowBoost)) continue;

        // Halo around the chest.
        const hx = (x - cx) / 88;
        const hy = (y - cy) / 70;
        const hd = Math.sqrt(hx * hx + hy * hy);
        let level = hd < 1 ? haloStrength * (1 - hd) ** 2.6 : 0;

        // Rings: each lock click, then the shockwave when the lock gives.
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
  };

  /** The stream out of the keyhole and the pile it makes. */
  const renderSand = (out: Uint8ClampedArray, since: number) => {
    const t = since - OPEN_AT;
    if (t <= 0) return;

    // Only sand that has reached the floor is in the pile.
    shapePile(fullVolume * clamp01((t - FALL_S) / TIMELINE.pour));

    for (let x = 0; x < width; x++) {
      const h = pile[x];
      if (h < 0.5) continue;
      const top = Math.round(height - h);
      for (let y = Math.max(0, top); y < height; y++) {
        // Lit from above: a bright crest, then darker the deeper the sand.
        const depth = y - top;
        const level = depth === 0 ? 1 : 0.78 - Math.min(1, depth / 30) * 0.45;
        const c = lightColour(level, bayer(x, y));
        if (c !== VOID) ink(out, (y * width + x) * 4, c);
      }
    }

    // The stream: its head falls from the keyhole as it starts, and then it never stops.
    const head = streamTop + 0.5 * SAND_GRAVITY * t * t;
    const floor = height - pile[streamX];
    const bottom = Math.min(head, floor);
    for (let y = streamTop; y < bottom; y++) {
      // Grains running down: noise scrolling with the fall, the odd gap, a slight wobble.
      const run = Math.floor(y - since * 70);
      const grain = hash(run * 7919 + 13);
      const wobble = hash(Math.floor(y / 5 - since * 12) * 31) > 0.88 ? 1 : 0;
      dot(out, streamX + wobble, y, 0.8 + 0.2 * grain);
      dot(out, streamX + wobble - 1, y, 0.55 + 0.45 * hash(run * 131 + 7));
      // A grain or two breaking off the edge of the stream.
      if (grain > 0.93) dot(out, streamX + wobble + (grain > 0.965 ? 1 : -2), y, 0.7);
    }

    // Where it lands, a few grains hop and roll off.
    if (head >= floor) {
      for (let j = 0; j < 6; j++) {
        const phase = (since * 2.6 + j / 6) % 1;
        const hop = Math.floor(since * 2.6 + j / 6);
        const side = hash(hop * 17 + j) < 0.5 ? -1 : 1;
        const x = streamX + side * (1 + phase * (3 + hash(hop * 29 + j) * 6));
        const y = floor - 1 - Math.sin(phase * Math.PI) * (2 + hash(hop * 41 + j) * 3);
        dot(out, Math.round(x), Math.round(y), 0.95 - phase * 0.4);
      }
    }
  };

  /**
   * @param clock seconds since the page started, seeds the glitches
   * @param since seconds since the hack started, or a negative number before
   */
  const render = (out: Uint8ClampedArray, clock: number, since: number) => {
    if (since >= CALM_AT) {
      if (!still) {
        renderChest(out, clock, since);
        still = out.slice();
      } else out.set(still);
    } else renderChest(out, clock, since);
    renderSand(out, since);
  };

  return { render };
}
