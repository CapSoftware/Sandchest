/**
 * Pixel text for the rendered brand images (`render-og.ts`, `render-readme.ts`):
 * the header wordmark and lines set in Jersey 10, as 1px masks to stamp onto a
 * grid at any whole scale.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";

const publicDir = join(import.meta.dirname, "..", "public");
const fontFile = join(import.meta.dirname, "og", "Jersey10-Regular.ttf");

export interface Mask {
  width: number;
  height: number;
  on: (x: number, y: number) => boolean;
}

/** Rasterises an SVG on its own 1px grid, without anti-aliasing, cropped to what it draws. */
export function mask(svg: string): Mask {
  const r = new Resvg(svg, {
    font: { fontFiles: [fontFile], loadSystemFonts: false, defaultFontFamily: "Jersey 10" },
    shapeRendering: 0,
    textRendering: 0,
  }).render();
  let minX = r.width;
  let minY = r.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      if (r.pixels[(y * r.width + x) * 4 + 3] < 128) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < 0) throw new Error("Nothing drawn");
  return {
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    on: (x, y) => r.pixels[((y + minY) * r.width + x + minX) * 4 + 3] >= 128,
  };
}

/** The header logo's wordmark, already drawn on the font's pixel grid. */
export function wordmark(): Mask {
  const logo = readFileSync(join(publicDir, "sandchest-logo-dark.svg"), "utf8");
  const path = logo.match(/<path fill="#FFF3DC"[^>]*\sd="([^"]+)"/)?.[1];
  if (!path) throw new Error("Wordmark not found in sandchest-logo-dark.svg");
  return mask(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="12"><path d="${path}"/></svg>`);
}

/** One line of Jersey 10 at its native 20px, on a 1px grid. */
export function line(text: string): Mask {
  return mask(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${text.length * 12 + 8}" height="32"><text x="2" y="22" font-size="20">${text}</text></svg>`,
  );
}
