/**
 * Renders the animation at the top of Sandchest's pull request comment: the
 * landing page's chest being hacked open until its sand has run out into a
 * dune. An animated PNG on a transparent ground, so it sits on either GitHub
 * theme, played once at twice the pace and left on the settled dune.
 *
 * Sized for a comment: cropped close around the chest, 12 frames a second,
 * and the hack's glitches (which repaint most of the chest every frame) held
 * for two frames each, so it stays around 60 KB.
 *
 * Needs ffmpeg on PATH. Run after changing the scene, then bump
 * PR_ANIMATION_VERSION in `src/server/scans.ts` so GitHub's image cache lets
 * go of the old one:
 *
 *   bun run chest:comment
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { createChestScene, SPRITE_W, STEADY_AT, TIMELINE } from "../src/lib/chest-dither";

const publicDir = join(import.meta.dirname, "..", "public");
const out = join(publicDir, "github", "review-chest.png");

const COLS = 152;
const ROWS = 120;
/** Drawn at 2× the size it is shown, so each cell is one CSS pixel and stays crisp. */
const CELL = 2;
const FPS = 12;
/** The hack plays this much faster than on the landing page. */
const SPEED = 2;
/** Seconds of the closed chest before the hack starts. */
const IDLE = 0.4;
const DURATION = IDLE + STEADY_AT / SPEED;
const FRAMES = Math.round(DURATION * FPS);
const W = COLS * CELL;
const H = ROWS * CELL;

const icon = readFileSync(join(publicDir, "sandchest-icon-flat.svg"));
const sprite = new Resvg(icon, { fitTo: { mode: "width", value: SPRITE_W } }).render();
const scene = createChestScene({ width: sprite.width, height: sprite.height, data: sprite.pixels }, COLS, ROWS);
const cells = new Uint8ClampedArray(COLS * ROWS * 4);
const frame = Buffer.alloc(W * H * 4);

/** Until the lock gives, each frame is shown twice. */
const HACKED_AT = TIMELINE.breach + TIMELINE.rattle;

function draw(f: number) {
  let t = f / FPS;
  if ((t - IDLE) * SPEED < HACKED_AT) t = (f - (f % 2)) / FPS;
  const since = (t - IDLE) * SPEED;
  scene.render(cells, t * SPEED, since < 0 ? -1 : since);
  frame.fill(0);
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const i = (row * COLS + col) * 4;
      if (!cells[i + 3]) continue;
      for (let y = row * CELL; y < (row + 1) * CELL; y++) {
        for (let x = col * CELL; x < (col + 1) * CELL; x++) {
          const o = (y * W + x) * 4;
          frame[o] = cells[i];
          frame[o + 1] = cells[i + 1];
          frame[o + 2] = cells[i + 2];
          frame[o + 3] = 255;
        }
      }
    }
  }
  return frame;
}

mkdirSync(join(out, ".."), { recursive: true });
const ffmpeg = spawn(
  "ffmpeg",
  [
    ...["-y", "-loglevel", "error"],
    ...["-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${H}`, "-r", String(FPS), "-i", "-"],
    ...["-filter_complex", "split[a][b];[a]palettegen=reserve_transparent=1:max_colors=8[p];[b][p]paletteuse=dither=none:alpha_threshold=128"],
    ...["-pix_fmt", "pal8", "-pred", "none", "-plays", "1", "-f", "apng", out],
  ],
  { stdio: ["pipe", "inherit", "inherit"] },
);
const done = new Promise<void>((resolve, reject) => {
  ffmpeg.on("error", reject);
  ffmpeg.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
});
for (let f = 0; f < FRAMES; f++) {
  if (!ffmpeg.stdin.write(Buffer.from(draw(f)))) await new Promise((r) => ffmpeg.stdin.once("drain", r));
}
ffmpeg.stdin.end();
await done;
console.log(`Wrote ${out} (${W}×${H}, ${FRAMES} frames at ${FPS} fps, ${DURATION.toFixed(1)}s)`);
