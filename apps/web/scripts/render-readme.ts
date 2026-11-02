/**
 * Renders the README's images into `.github/readme/`, each in a light and a
 * dark version so it sits on either GitHub theme:
 *
 * - `hero-*.png`: the logo lockup. The landing page's chest is hacked open
 *   above the wordmark and the hero line, on a transparent ground. An animated PNG,
 *   which every current browser plays, at a quarter of a GIF's size. It
 *   loops like the og video, dissolving back to the closed chest.
 * - `finding-*.svg`, `step-*.svg`, `models-*.svg`: the landing's example
 *   finding and How it works windows, drawn as SVG with CSS animations that
 *   play, rest, then start again.
 *
 * Needs ffmpeg on PATH. Run after changing the scene, the landing's copy or
 * these windows:
 *
 *   bun run readme
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { bayer, createChestScene, SPRITE_W, STEADY_AT } from "../src/lib/chest-dither";
import { line, type Mask, wordmark as brandWordmark } from "./pixel-text";
import { renderWindows } from "./readme/windows";

const root = join(import.meta.dirname, "..", "..", "..");
const outDir = join(root, ".github", "readme");
const publicDir = join(import.meta.dirname, "..", "public");
mkdirSync(outDir, { recursive: true });

type Rgb = readonly [number, number, number];
const rgb = (h: string): Rgb => [Number.parseInt(h.slice(1, 3), 16), Number.parseInt(h.slice(3, 5), 16), Number.parseInt(h.slice(5, 7), 16)];

/** Drawn at 2× the size it is shown, so each 4px cell is 2 CSS pixels and stays crisp. */
const W = 1200;
const CELL = 4;
const COLS = W / CELL;
/** Rows of the chest's scene, at the top. The text sits below it. */
const SCENE_ROWS = 140;
const FPS = 20;
const TAGLINE = "Add a hacker to your team.";
const WORDMARK_SCALE = 7;
const TAGLINE_SCALE = 3;
const TEXT_GAP = 28;

/** Seconds: closed, the hack (to STEADY_AT), burning, then back to closed. */
const IDLE = 0.8;
const BURN = 3;
const DISSOLVE = 0.6;
const DURATION = IDLE + STEADY_AT + BURN + DISSOLVE;
const FRAMES = Math.round(DURATION * FPS);

const THEMES = {
  dark: { wordmark: rgb("#fff3dc"), tagline: rgb("#c2b293"), cursor: rgb("#fec242") },
  light: { wordmark: rgb("#15100b"), tagline: rgb("#6b5a44"), cursor: rgb("#ff9f19") },
} as const;

const icon = readFileSync(join(publicDir, "sandchest-icon-flat.svg"));
const sprite = new Resvg(icon, { fitTo: { mode: "width", value: SPRITE_W } }).render();
const scene = createChestScene({ width: sprite.width, height: sprite.height, data: sprite.pixels }, COLS, SCENE_ROWS);
const burning = new Uint8ClampedArray(COLS * SCENE_ROWS * 4);
const closed = new Uint8ClampedArray(COLS * SCENE_ROWS * 4);
scene.render(closed, 0, -1);

const wordmark = brandWordmark();
const tagline = line(TAGLINE);
const taglineCap = line("A").height;

// The wordmark and the hero line are centred under the chest, the line with its cursor.
const wordmarkTop = SCENE_ROWS * CELL - 8;
const taglineTop = wordmarkTop + wordmark.height * WORDMARK_SCALE + TEXT_GAP;
const H = Math.ceil((taglineTop + tagline.height * TAGLINE_SCALE + 24) / CELL) * CELL;
const cursorW = 5 * TAGLINE_SCALE;
const cursorGap = 2 * TAGLINE_SCALE;
const taglineLeft = Math.round((W - tagline.width * TAGLINE_SCALE - cursorGap - cursorW) / 2);
const cursor = {
  x: taglineLeft + tagline.width * TAGLINE_SCALE + cursorGap,
  y: taglineTop,
  w: cursorW,
  h: taglineCap * TAGLINE_SCALE,
};

/** Which text, if any, covers each pixel: 1 the wordmark, 2 the tagline. */
const text = new Uint8Array(W * H);
const stamp = (m: Mask, left: number, top: number, scale: number, kind: number) => {
  for (let y = 0; y < m.height * scale; y++) {
    for (let x = 0; x < m.width * scale; x++) {
      if (m.on(Math.floor(x / scale), Math.floor(y / scale))) text[(top + y) * W + left + x] = kind;
    }
  }
};
stamp(wordmark, Math.round((W - wordmark.width * WORDMARK_SCALE) / 2), wordmarkTop, WORDMARK_SCALE, 1);
stamp(tagline, taglineLeft, taglineTop, TAGLINE_SCALE, 2);

const frame = Buffer.alloc(W * H * 4);

function draw(t: number, theme: (typeof THEMES)[keyof typeof THEMES]) {
  const since = t - IDLE;
  if (since < 0) burning.set(closed);
  else scene.render(burning, t, since);
  const back = Math.max(0, (t - (DURATION - DISSOLVE)) / DISSOLVE);
  frame.fill(0);

  for (let row = 0; row < SCENE_ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const src = back > 0 && bayer(col, row) < back ? closed : burning;
      const i = (row * COLS + col) * 4;
      if (!src[i + 3]) continue;
      for (let y = row * CELL; y < (row + 1) * CELL; y++) {
        for (let x = col * CELL; x < (col + 1) * CELL; x++) {
          const o = (y * W + x) * 4;
          frame[o] = src[i];
          frame[o + 1] = src[i + 1];
          frame[o + 2] = src[i + 2];
          frame[o + 3] = 255;
        }
      }
    }
  }

  for (let p = 0; p < W * H; p++) {
    if (!text[p]) continue;
    frame.set(text[p] === 1 ? theme.wordmark : theme.tagline, p * 4);
    frame[p * 4 + 3] = 255;
  }

  // A terminal cursor after the hero line, blinking once a second.
  if (t % 1 < 0.5) {
    for (let y = cursor.y; y < cursor.y + cursor.h; y++) {
      for (let x = cursor.x; x < cursor.x + cursor.w; x++) {
        frame.set(theme.cursor, (y * W + x) * 4);
        frame[(y * W + x) * 4 + 3] = 255;
      }
    }
  }
  return frame;
}

/** A looping animated PNG with a transparent ground. The scene has a handful of colours, so a palette is exact. */
async function apng(name: string, theme: (typeof THEMES)[keyof typeof THEMES]) {
  const ffmpeg = spawn(
    "ffmpeg",
    [
      ...["-y", "-loglevel", "error"],
      ...["-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${H}`, "-r", String(FPS), "-i", "-"],
      ...["-filter_complex", "split[a][b];[a]palettegen=reserve_transparent=1:max_colors=32[p];[b][p]paletteuse=dither=none:alpha_threshold=128"],
      ...["-pix_fmt", "pal8", "-plays", "0", "-f", "apng", join(outDir, name)],
    ],
    { stdio: ["pipe", "inherit", "inherit"] },
  );
  const done = new Promise<void>((resolve, reject) => {
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
  });
  for (let f = 0; f < FRAMES; f++) {
    if (!ffmpeg.stdin.write(Buffer.from(draw(f / FPS, theme)))) await new Promise((r) => ffmpeg.stdin.once("drain", r));
  }
  ffmpeg.stdin.end();
  await done;
  console.log(`Wrote ${name} (${W}×${H}, ${FRAMES} frames at ${FPS} fps)`);
}

for (const [name, theme] of Object.entries(THEMES)) await apng(`hero-${name}.png`, theme);
for (const [name, svg] of renderWindows()) {
  writeFileSync(join(outDir, name), svg);
  console.log(`Wrote ${name}`);
}
