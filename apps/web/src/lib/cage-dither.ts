import { bayer, clamp01, hash, LIGHT_RAMP } from "./chest-dither";

/**
 * The sandbox: one scan's VM as a box of sand, in the chest's pixel palette.
 * The model keeps kicking grains up; they fly, bounce off the walls and pour
 * back into the pile. None get out. That's the whole picture, and it loops.
 *
 * The sand is a small falling-sand simulation: each grain falls if it can,
 * else slides down a diagonal, so kicked-up grains land and avalanche like
 * sand. Grains in the air are particles until they land.
 *
 * Geometry is in fractions of the scene so the HTML labels around the box can
 * be placed with the same numbers (see `.cage-label` in globals.css).
 */
export const CAGE = { left: 0.36, right: 0.64, top: 0.2, bottom: 0.86, depthX: 0.03, depthY: -0.08 } as const;

/** Scene height in grid cells. Must match --cage-rows in globals.css. */
export const CAGE_ROWS = 120;

export type Wall = "top" | "left" | "right";
export type Hits = Record<Wall, boolean>;

type Rgb = readonly [number, number, number];
const STEPS = LIGHT_RAMP.length - 1;

const hex = (h: string): Rgb => [Number.parseInt(h.slice(1, 3), 16), Number.parseInt(h.slice(3, 5), 16), Number.parseInt(h.slice(5, 7), 16)];
/** Sand, darkest (deep in the pile) to brightest (the lit surface). */
const SAND: readonly Rgb[] = [hex("#C25A2C"), hex("#D76839"), hex("#FF9F19"), hex("#FEA121"), hex("#FEC242")];

/** Gravity, in cells per second squared, and how much speed a grain keeps off a wall. */
const GRAVITY = 140;
const BOUNCE = 0.55;
/** How long a wall's break lasts, and how long its label stays lit. */
const IMPACT_FOR = 0.45;
const LABEL_FOR = 0.3;
/** Seconds between kicks, and grains per kick. */
const KICK_EVERY = [0.35, 0.8] as const;
const KICK_GRAINS = [5, 11] as const;
/** The pile's share of the box's height. */
const FILL = 0.3;

interface Grain {
  x: number;
  y: number;
  vx: number;
  vy: number;
  shade: number;
}

export function createCageScene(width: number, height: number) {
  const L = Math.round(width * CAGE.left);
  const R = Math.round(width * CAGE.right);
  const Tp = Math.round(height * CAGE.top);
  const B = Math.round(height * CAGE.bottom);
  const dx = Math.round(width * CAGE.depthX);
  const dy = Math.round(height * CAGE.depthY);

  // The inside of the box, as its own grid: 0 is air, otherwise a grain's shade (1–255).
  const gx0 = L + 1;
  const gy0 = Tp + 1;
  const gw = Math.max(1, R - L - 1);
  const gh = Math.max(1, B - Tp - 1);
  const grid = new Uint8Array(gw * gh);
  const at = (x: number, y: number) => grid[y * gw + x]!;

  // A settled dune to start from: higher in the middle, a ripple across it.
  for (let x = 0; x < gw; x++) {
    const u = x / gw;
    const dune = FILL + 0.08 * Math.cos((u - 0.55) * Math.PI * 1.6) + 0.025 * Math.sin(u * 19);
    const top = Math.round(gh * (1 - dune));
    for (let y = Math.max(0, top); y < gh; y++) grid[y * gw + x] = 1 + Math.floor(hash(x * 131 + y * 17) * 254);
  }

  const flying: Grain[] = [];
  const impacts: Array<{ x: number; y: number; age: number }> = [];
  const lastHit: Record<Wall, number> = { top: -1, left: -1, right: -1 };
  let time = 0;
  let nextKick = 0.2;
  let flip = false;

  const surface = (x: number) => {
    for (let y = 0; y < gh; y++) if (at(x, y)) return y;
    return gh;
  };

  /** Lifts a handful of grains off the pile near one spot and throws them toward the walls. */
  const kick = () => {
    const cx = Math.floor(gw * (0.2 + Math.random() * 0.6));
    const n = KICK_GRAINS[0] + Math.floor(Math.random() * (KICK_GRAINS[1] - KICK_GRAINS[0] + 1));
    // Mostly up, leaning left or right: some reach the top, some the sides.
    const lean = (Math.random() - 0.5) * 2;
    for (let i = 0; i < n; i++) {
      const x = Math.min(gw - 1, Math.max(0, cx + Math.round((Math.random() - 0.5) * 4)));
      const y = surface(x);
      if (y >= gh) continue;
      const shade = at(x, y);
      grid[y * gw + x] = 0;
      const speed = 95 + Math.random() * 70;
      const angle = -Math.PI / 2 + lean * 0.9 + (Math.random() - 0.5) * 0.5;
      flying.push({ x, y: y - 1, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, shade });
    }
  };

  /** Drops a grain into the pile at the first free cell at or above where it came down. */
  const land = (g: Grain) => {
    const x = Math.min(gw - 1, Math.max(0, Math.round(g.x)));
    let y = Math.min(gh - 1, Math.max(0, Math.round(g.y)));
    while (y > 0 && at(x, y)) y--;
    if (!at(x, y)) grid[y * gw + x] = g.shade;
  };

  const wallHit = (wall: Wall, x: number, y: number) => {
    lastHit[wall] = time;
    impacts.push({ x: gx0 + x, y: gy0 + y, age: 0 });
  };

  /** Advances the sand by `dt` seconds. */
  const step = (dt: number) => {
    time += dt;

    if (time >= nextKick) {
      kick();
      nextKick = time + KICK_EVERY[0] + Math.random() * (KICK_EVERY[1] - KICK_EVERY[0]);
    }

    // Grains in the air: fly, bounce off the walls, land on the pile.
    for (let i = flying.length - 1; i >= 0; i--) {
      const g = flying[i]!;
      g.vy += GRAVITY * dt;
      g.x += g.vx * dt;
      g.y += g.vy * dt;
      if (g.x < 0) {
        g.x = 0;
        if (g.vx < -20) wallHit("left", 0, g.y);
        g.vx = -g.vx * BOUNCE;
      } else if (g.x > gw - 1) {
        g.x = gw - 1;
        if (g.vx > 20) wallHit("right", gw - 1, g.y);
        g.vx = -g.vx * BOUNCE;
      }
      if (g.y < 0) {
        g.y = 0;
        if (g.vy < -20) wallHit("top", g.x, 0);
        g.vy = -g.vy * BOUNCE;
      }
      const cx = Math.round(g.x);
      const cy = Math.round(g.y);
      if (g.vy > 0 && (cy >= gh - 1 || (cy >= 0 && at(cx, Math.min(gh - 1, cy + 1))))) {
        land(g);
        flying.splice(i, 1);
      }
    }

    // The pile: bottom up, each grain falls if it can, else slides down a diagonal.
    flip = !flip;
    for (let y = gh - 2; y >= 0; y--) {
      for (let k = 0; k < gw; k++) {
        const x = flip ? k : gw - 1 - k;
        const g = at(x, y);
        if (!g) continue;
        const below = (y + 1) * gw;
        if (!grid[below + x]) {
          grid[below + x] = g;
          grid[y * gw + x] = 0;
          continue;
        }
        const first = Math.random() < 0.5 ? -1 : 1;
        for (const side of [first, -first]) {
          const nx = x + side;
          if (nx < 0 || nx >= gw || grid[below + nx]) continue;
          // Sand rests at an angle: only slide if the cell beside it is open too.
          if (grid[y * gw + nx]) continue;
          grid[below + nx] = g;
          grid[y * gw + x] = 0;
          break;
        }
      }
    }

    for (let i = impacts.length - 1; i >= 0; i--) {
      impacts[i]!.age += dt;
      if (impacts[i]!.age > IMPACT_FOR) impacts.splice(i, 1);
    }
  };

  const put = (out: Uint8ClampedArray, x: number, y: number, c: Rgb) => {
    const i = (y * width + x) * 4;
    out[i] = c[0];
    out[i + 1] = c[1];
    out[i + 2] = c[2];
    out[i + 3] = 255;
  };

  /** Ink one cell at a light level, dithered into the ramp. */
  const dot = (out: Uint8ClampedArray, x: number, y: number, level: number) => {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= width || y >= height || level <= 0) return;
    const s = Math.floor(clamp01(level) * STEPS + bayer(x, y));
    if (s > 0) put(out, x, y, LIGHT_RAMP[s > STEPS ? STEPS : s]!);
  };

  const line = (out: Uint8ClampedArray, x0: number, y0: number, x1: number, y1: number, level: (x: number, y: number) => number) => {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) || 1;
    for (let s = 0; s <= n; s++) {
      const x = x0 + ((x1 - x0) * s) / n;
      const y = y0 + ((y1 - y0) * s) / n;
      dot(out, x, y, level(x, y));
    }
  };

  /** Light where a grain hit the glass: a flash, and a ring running out along the wall. */
  const shock = (x: number, y: number) => {
    let level = 0;
    for (const im of impacts) {
      const d = Math.hypot(x - im.x, y - im.y);
      const fade = 1 - im.age / IMPACT_FOR;
      level += fade * (Math.exp(-((d - im.age * 30) ** 2) / 5) * 0.7 + Math.exp(-(d * d) / 6) * fade);
    }
    return level;
  };

  /** Draws the scene and reports which walls a grain hit just now. */
  const render = (out: Uint8ClampedArray): Hits => {
    out.fill(0);

    // The pile, lit from above: bright on top, darker the deeper a grain sits, dithered between.
    for (let x = 0; x < gw; x++) {
      let depth = 0;
      for (let y = 0; y < gh; y++) {
        const g = at(x, y);
        if (!g) {
          depth = 0;
          continue;
        }
        const level = clamp01(1 - depth / 34) * 0.78 + (g / 255) * 0.22;
        const s = Math.floor(level * (SAND.length - 1) + bayer(gx0 + x, gy0 + y));
        put(out, gx0 + x, gy0 + y, SAND[Math.min(SAND.length - 1, Math.max(0, s))]!);
        depth++;
      }
    }

    // Grains in the air, with a one-cell trail.
    for (const g of flying) {
      const x = Math.round(gx0 + g.x);
      const y = Math.round(gy0 + g.y);
      put(out, x, y, SAND[4]!);
      const tx = Math.round(gx0 + g.x - g.vx * 0.012);
      const ty = Math.round(gy0 + g.y - g.vy * 0.012);
      if ((tx !== x || ty !== y) && tx > L && tx < R && ty > Tp && ty < B) put(out, tx, ty, SAND[2]!);
    }

    // The box: the back drawn dim, then the front, which lights up where a grain hits it.
    const back = () => 0.3;
    line(out, L + dx, Tp + dy, R + dx, Tp + dy, back);
    line(out, R + dx, Tp + dy, R + dx, B + dy, back);
    line(out, L, Tp, L + dx, Tp + dy, back);
    line(out, R, Tp, R + dx, Tp + dy, back);
    line(out, R, B, R + dx, B + dy, back);
    const front = (x: number, y: number) => 0.7 + shock(x, y) * 1.2;
    line(out, L, Tp, R, Tp, front);
    line(out, R, Tp, R, B, front);
    line(out, R, B, L, B, front);
    line(out, L, B, L, Tp, front);

    const lit = (wall: Wall) => lastHit[wall] >= 0 && time - lastHit[wall] < LABEL_FOR;
    return { top: lit("top"), left: lit("left"), right: lit("right") };
  };

  return { step, render };
}
