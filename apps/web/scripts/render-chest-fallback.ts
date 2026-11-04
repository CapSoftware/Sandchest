/**
 * Renders the static, finished frame (the chest in its dune of sand) used
 * when JavaScript is unavailable or the visitor prefers reduced motion. Run
 * after changing the renderer:
 *
 *   bun run chest:fallback
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { PNG } from "pngjs";
import {
  createChestScene,
  FALLBACK_H,
  FALLBACK_W,
  SPRITE_W,
  STEADY_AT,
} from "../src/lib/chest-dither";

const publicDir = join(import.meta.dirname, "..", "public");

const svg = readFileSync(join(publicDir, "sandchest-icon-flat.svg"));
const raster = new Resvg(svg, { fitTo: { mode: "width", value: SPRITE_W } }).render();

const scene = createChestScene(
  { width: raster.width, height: raster.height, data: raster.pixels },
  FALLBACK_W,
  FALLBACK_H,
);

const png = new PNG({ width: FALLBACK_W, height: FALLBACK_H });
const frame = new Uint8ClampedArray(FALLBACK_W * FALLBACK_H * 4);
// The sand has run out and settled.
scene.render(frame, 2.4, STEADY_AT + 2);
png.data = Buffer.from(frame);

writeFileSync(join(publicDir, "chest-dither.png"), PNG.sync.write(png));
console.log(`Wrote chest-dither.png (${FALLBACK_W}×${FALLBACK_H})`);
