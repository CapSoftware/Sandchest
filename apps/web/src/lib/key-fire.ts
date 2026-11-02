/**
 * The hero key's hover fire, drawn on the same dithered grid as the chest:
 * flames lick off the key's top edge, a burst of sparks when it lights, then
 * embers and hex glyphs drift up while the pointer stays.
 */
import { bayer, GLYPHS, LIGHT_RAMP, noise } from "./chest-dither";

const STEPS = LIGHT_RAMP.length - 1;
const GRAVITY = 110;

type Particle = { kind: "spark" | "ember" | "glyph"; x: number; y: number; vx: number; vy: number; age: number; life: number; seed: number };

/** The key's rectangle, in grid cells. */
export type KeyRect = { x: number; y: number; w: number; h: number };

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function createKeyFire(width: number, height: number, key: KeyRect) {
  const particles: Particle[] = [];
  let heat = 0;
  let clock = 0;
  let wasHot = false;
  let emberDebt = 0;
  let glyphDebt = 0;

  const spawn = (kind: Particle["kind"], x: number, y: number, vx: number, vy: number, life: number) =>
    particles.push({ kind, x, y, vx, vy, age: 0, life, seed: Math.random() * 100 });

  const fromTop = () => key.x + 1 + Math.random() * (key.w - 2);

  /** Advances by `dt` seconds. Returns whether anything is still visible. */
  const step = (dt: number, hot: boolean) => {
    clock += dt;
    heat += ((hot ? 1 : 0) - heat) * Math.min(1, dt * (hot ? 9 : 4));
    if (heat < 0.01 && !hot) heat = 0;

    if (hot && !wasHot) {
      for (let i = 0; i < 22; i++) {
        const angle = -Math.PI / 2 + (Math.random() - 0.5) * 2.6;
        const speed = 35 + Math.random() * 60;
        spawn("spark", fromTop(), key.y, Math.cos(angle) * speed, Math.sin(angle) * speed, 0.35 + Math.random() * 0.45);
      }
    }
    wasHot = hot;

    if (hot) {
      emberDebt += dt * 16;
      glyphDebt += dt * 5;
      for (; emberDebt >= 1; emberDebt--) spawn("ember", fromTop(), key.y - 2, (Math.random() - 0.5) * 5, -(12 + Math.random() * 14), 0.8 + Math.random() * 0.9);
      for (; glyphDebt >= 1; glyphDebt--) spawn("glyph", fromTop(), key.y - 4, (Math.random() - 0.5) * 3, -(9 + Math.random() * 7), 1 + Math.random() * 0.6);
    }

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.age += dt;
      if (p.age >= p.life || p.y < -6) {
        particles.splice(i, 1);
        continue;
      }
      if (p.kind === "spark") p.vy += GRAVITY * dt;
      else p.vx += Math.sin(clock * 5 + p.seed) * 9 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }

    return heat > 0 || particles.length > 0;
  };

  const dot = (out: Uint8ClampedArray, x: number, y: number, level: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height || level <= 0) return;
    const s = Math.floor(clamp01(level) * STEPS + bayer(x, y));
    if (s <= 0) return;
    const c = LIGHT_RAMP[s > STEPS ? STEPS : s];
    const i = (y * width + x) * 4;
    out[i] = c[0];
    out[i + 1] = c[1];
    out[i + 2] = c[2];
    out[i + 3] = 255;
  };

  const render = (out: Uint8ClampedArray) => {
    out.fill(0);
    const right = key.x + key.w;

    // Flames off the top edge: gold at the root, ember at the tips, tapered at the ends.
    if (heat > 0) {
      for (let x = key.x; x < right; x++) {
        const edge = clamp01(Math.min(x - key.x, right - 1 - x) / 10);
        const swell = noise(x * 0.08, clock * 1.4) ** 1.4;
        const lick = 0.55 + 0.9 * noise(x * 0.32, clock * 3.2);
        const tall = heat * edge * (3 + 14 * swell) * lick;
        for (let dy = -1; dy < tall; dy++) {
          const turb = noise(x * 0.27, dy * 0.32 + clock * 6.5) - 0.5;
          dot(out, x, key.y - 1 - dy, (1 - dy / tall) * 1.25 + turb * 0.55);
        }
      }
    }

    for (const p of particles) {
      const fade = 1 - p.age / p.life;
      const x = Math.round(p.x);
      const y = Math.round(p.y);
      if (p.kind === "glyph") {
        const bits = GLYPHS[Math.floor(p.seed) & 15];
        for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) if (bits[r * 3 + c]) dot(out, x - 1 + c, y - 2 + r, fade * 0.95);
      } else if (p.kind === "spark") {
        dot(out, x, y, fade * 1.1);
        dot(out, Math.round(p.x - p.vx * 0.02), Math.round(p.y - p.vy * 0.02), fade * 0.6);
      } else {
        dot(out, x, y, fade * (0.75 + 0.25 * Math.sin(clock * 20 + p.seed)));
      }
    }
  };

  return { step, render };
}
