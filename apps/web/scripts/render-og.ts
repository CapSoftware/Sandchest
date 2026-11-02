/**
 * Renders the link previews: `public/og.mp4` (og:video) and `public/og.png`
 * (og:image, shown wherever video isn't played, and as the video's poster).
 *
 * The chest is the landing page's hero scene from `src/lib/chest-dither.ts`,
 * drawn on a 4px grid beside the pixel wordmark and the hero line. The video
 * is hacked open, burns, then dissolves back to the closed chest, so it loops
 * without a seam. Needs ffmpeg on PATH. Run after changing the scene or the
 * copy, then bump BRAND_VERSION in `src/lib/site.ts`:
 *
 *   bun run og
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { PNG } from "pngjs";
import { bayer, createChestScene, SPRITE_W, STEADY_AT } from "../src/lib/chest-dither";
import { type Mask, line, wordmark as brandWordmark } from "./pixel-text";

const publicDir = join(import.meta.dirname, "..", "public");

/** Output size: the 1.91:1 card every network crops to. */
const W = 1200;
const H = 630;
const FPS = 30;
/** Screen pixels per scene cell. Even, so cells line up with the video's 2 × 2 chroma blocks. */
const CELL = 4;
const COLS = W / CELL;
const ROWS = Math.ceil(H / CELL);
/** The scene is shorter than the frame, which lifts the chest off the bottom edge. */
const SCENE_ROWS = 148;
/** Column the chest is centred on. */
const CHEST_COL = 72;

const TAGLINE = "Add a hacker to your team.";
/** Screen pixels per font pixel: Jersey 10 sits on a 1px grid at 20px. */
const WORDMARK_SCALE = 8;
const TAGLINE_SCALE = 3;
const TEXT_LEFT = 552;
const TEXT_GAP = 30;

/** Seconds: closed, the hack (to STEADY_AT), burning, then back to closed. */
const IDLE = 0.6;
const BURN = 2.75;
const DISSOLVE = 0.6;
const DURATION = IDLE + STEADY_AT + BURN + DISSOLVE;
const FRAMES = Math.round(DURATION * FPS);
/** The poster frame: the chest open and burning. */
const POSTER_AT = IDLE + STEADY_AT + 0.75;

type Rgb = readonly [number, number, number];
const VOID: Rgb = [0x0d, 0x0a, 0x07];
const BRIGHT: Rgb = [0xff, 0xf3, 0xdc];
const MUTED: Rgb = [0xc2, 0xb2, 0x93];
const GOLD: Rgb = [0xfe, 0xc2, 0x42];

// The scene is rendered wider than the frame so the chest can sit left of
// centre while its glow, glyphs and shockwave still reach the far edge.
const sceneCols = 2 * (COLS - CHEST_COL);
const sceneLeft = CHEST_COL - sceneCols / 2;

const icon = readFileSync(join(publicDir, "sandchest-icon-flat.svg"));
const sprite = new Resvg(icon, { fitTo: { mode: "width", value: SPRITE_W } }).render();
const scene = createChestScene({ width: sprite.width, height: sprite.height, data: sprite.pixels }, sceneCols, SCENE_ROWS);
const burning = new Uint8ClampedArray(sceneCols * SCENE_ROWS * 4);
const closed = new Uint8ClampedArray(sceneCols * SCENE_ROWS * 4);
scene.render(closed, 0, -1);

const wordmark = brandWordmark();
const tagline = line(TAGLINE);
// Baseline to cap top, for the cursor: the tagline's tallest letter without a descender.
const taglineCap = line("A").height;

// The text block is centred on the closed chest's body.
const chestMid = (SCENE_ROWS - 22 - 39) * CELL;
const blockHeight = wordmark.height * WORDMARK_SCALE + TEXT_GAP + tagline.height * TAGLINE_SCALE;
const wordmarkTop = Math.round((chestMid - blockHeight / 2) / 2) * 2;
const taglineTop = wordmarkTop + wordmark.height * WORDMARK_SCALE + TEXT_GAP;
const taglineRight = TEXT_LEFT + tagline.width * TAGLINE_SCALE;
const cursor = {
  x: taglineRight + 2 * TAGLINE_SCALE,
  y: taglineTop,
  w: 5 * TAGLINE_SCALE,
  h: taglineCap * TAGLINE_SCALE,
};
if (cursor.x + cursor.w > W - 48) throw new Error("The text runs off the right edge");

/** The static text, as an RGB colour per pixel or nothing. */
const text: (Rgb | undefined)[] = new Array(W * H);
const stamp = (m: Mask, left: number, top: number, scale: number, colour: Rgb) => {
  for (let y = 0; y < m.height * scale; y++) {
    for (let x = 0; x < m.width * scale; x++) {
      if (m.on(Math.floor(x / scale), Math.floor(y / scale))) text[(top + y) * W + left + x] = colour;
    }
  }
};
stamp(wordmark, TEXT_LEFT, wordmarkTop, WORDMARK_SCALE, BRIGHT);
stamp(tagline, TEXT_LEFT, taglineTop, TAGLINE_SCALE, MUTED);

const frame = Buffer.alloc(W * H * 3);

function draw(t: number, cursorOn = t % 1 < 0.5) {
  const since = t - IDLE;
  if (since < 0) burning.set(closed);
  else scene.render(burning, t, since);
  // At the end the fire dissolves, cell by cell, back to the closed chest.
  const back = Math.max(0, (t - (DURATION - DISSOLVE)) / DISSOLVE);

  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const sx = col - sceneLeft;
      let colour = VOID;
      if (row < SCENE_ROWS && sx >= 0 && sx < sceneCols) {
        const src = back > 0 && bayer(col, row) < back ? closed : burning;
        const i = (row * sceneCols + sx) * 4;
        if (src[i + 3]) colour = [src[i], src[i + 1], src[i + 2]];
      }
      for (let y = row * CELL; y < Math.min(H, (row + 1) * CELL); y++) {
        for (let x = col * CELL; x < (col + 1) * CELL; x++) {
          const o = (y * W + x) * 3;
          const c = text[y * W + x] ?? colour;
          frame[o] = c[0];
          frame[o + 1] = c[1];
          frame[o + 2] = c[2];
        }
      }
    }
  }

  // A terminal cursor after the hero line, blinking once a second.
  if (cursorOn) {
    for (let y = cursor.y; y < cursor.y + cursor.h; y++) {
      for (let x = cursor.x; x < cursor.x + cursor.w; x++) frame.set(GOLD, (y * W + x) * 3);
    }
  }
  return frame;
}

const poster = new PNG({ width: W, height: H, colorType: 2 });
const posterRgb = draw(POSTER_AT, true);
for (let p = 0; p < W * H; p++) {
  poster.data[p * 4] = posterRgb[p * 3];
  poster.data[p * 4 + 1] = posterRgb[p * 3 + 1];
  poster.data[p * 4 + 2] = posterRgb[p * 3 + 2];
  poster.data[p * 4 + 3] = 255;
}
writeFileSync(join(publicDir, "og.png"), PNG.sync.write(poster, { colorType: 2 }));
console.log(`Wrote og.png (${W}×${H})`);

// H.264 High, 4:2:0, BT.709 and faststart: what every network's player and
// every phone decodes. No audio track, so previews autoplay where they can.
const ffmpeg = spawn(
  "ffmpeg",
  [
    ...["-y", "-loglevel", "error"],
    ...["-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${W}x${H}`, "-r", String(FPS), "-i", "-"],
    ...["-vf", "scale=out_color_matrix=bt709:out_range=tv:flags=neighbor,format=yuv420p"],
    ...["-c:v", "libx264", "-preset", "veryslow", "-tune", "animation", "-crf", "20"],
    ...["-profile:v", "high", "-level", "4.0", "-g", String(FPS * 2)],
    ...["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"],
    ...["-movflags", "+faststart", "-an", join(publicDir, "og.mp4")],
  ],
  { stdio: ["pipe", "inherit", "inherit"] },
);
const done = new Promise<void>((resolve, reject) => {
  ffmpeg.on("error", reject);
  ffmpeg.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
});
for (let f = 0; f < FRAMES; f++) {
  // Copied: the frame buffer is reused while ffmpeg may still hold the last one.
  if (!ffmpeg.stdin.write(Buffer.from(draw(f / FPS)))) await new Promise((r) => ffmpeg.stdin.once("drain", r));
}
ffmpeg.stdin.end();
await done;
console.log(`Wrote og.mp4 (${W}×${H}, ${FRAMES} frames at ${FPS} fps, ${DURATION.toFixed(2)} s)`);
